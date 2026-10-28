#!/usr/bin/env python3
"""Turn the recorded dshell writes into a 1080p video.

`demo.mjs` records every chunk the TUI painted (ANSI, with absolute cursor
addressing). This replays those chunks into a small screen model, samples it at
a fixed frame rate, draws each frame inside a terminal window with captions,
and lets ffmpeg encode the result.

    python3 docs/promo/render.py --dump 8 20 40     # text of a few moments
    python3 docs/promo/render.py                    # frames + mp4
"""
from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"

WIDTH, HEIGHT = 1920, 1080
COLS, ROWS = 110, 28
CELL_W, CELL_H = 15, 31
FONT_SIZE = 28
BASELINE = 23
FPS = 15

WIN_X, WIN_Y = 120, 52
TITLE_H = 44
PAD = 14
CONTENT_X = WIN_X + 15
CONTENT_Y = WIN_Y + TITLE_H + PAD
CONTENT_W = COLS * CELL_W
CONTENT_H = ROWS * CELL_H
WIN_W = CONTENT_W + 30
WIN_H = TITLE_H + PAD * 2 + CONTENT_H

DEFAULT_FG = (220, 227, 240)
DEFAULT_BG = (16, 19, 26)
ACCENT = (77, 107, 254)

FONT_DIR = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
MONO_INDEX = 7  # Noto Sans Mono CJK SC
SYMBOL_FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]

# ---------------------------------------------------------------- screen model


@dataclass
class Attr:
    fg: tuple[int, int, int] | None = None
    bg: tuple[int, int, int] | None = None
    bold: bool = False
    dim: bool = False


@dataclass
class Cell:
    ch: str = " "
    fg: tuple[int, int, int] | None = None
    bg: tuple[int, int, int] | None = None
    bold: bool = False
    dim: bool = False


def is_wide(ch: str) -> bool:
    code = ord(ch)
    return (
        0x1100 <= code <= 0x115F
        or 0x2E80 <= code <= 0xA4CF
        or 0xAC00 <= code <= 0xD7A3
        or 0xF900 <= code <= 0xFAFF
        or 0xFF00 <= code <= 0xFF60
        or 0xFFE0 <= code <= 0xFFE6
        or 0x1F300 <= code <= 0x1FAFF
    )


class Screen:
    def __init__(self, cols: int, rows: int) -> None:
        self.cols = cols
        self.rows = rows
        self.grid = [[Cell() for _ in range(cols)] for _ in range(rows)]
        self.row = 0
        self.col = 0
        self.attr = Attr()
        self.blank()

    def blank(self) -> None:
        self.grid = [[Cell() for _ in range(self.cols)] for _ in range(self.rows)]

    def put(self, ch: str) -> None:
        if self.col >= self.cols:
            self.col = 0
            self.row += 1
            if self.row >= self.rows:
                self.grid.pop(0)
                self.grid.append([Cell() for _ in range(self.cols)])
                self.row = self.rows - 1
        w = 2 if is_wide(ch) else 1
        cell = Cell(ch, self.attr.fg, self.attr.bg, self.attr.bold, self.attr.dim)
        self.grid[self.row][self.col] = cell
        if w == 2 and self.col + 1 < self.cols:
            self.grid[self.row][self.col + 1] = Cell("", self.attr.fg, self.attr.bg, self.attr.bold, self.attr.dim)
        self.col += w

    def feed(self, data: str) -> None:
        index = 0
        length = len(data)
        while index < length:
            ch = data[index]
            if ch == "\x1b":
                index = self.escape(data, index)
                continue
            if ch == "\n":
                self.col = 0
                self.row += 1
                if self.row >= self.rows:
                    self.grid.pop(0)
                    self.grid.append([Cell() for _ in range(self.cols)])
                    self.row = self.rows - 1
            elif ch == "\r":
                self.col = 0
            elif ch == "\b":
                self.col = max(0, self.col - 1)
            elif ch == "\t":
                self.col = min(self.cols - 1, (self.col // 8 + 1) * 8)
            elif ch >= " ":
                self.put(ch)
            index += 1

    def escape(self, data: str, index: int) -> int:
        if index + 1 >= len(data):
            return len(data)
        kind = data[index + 1]
        if kind == "[":
            match = re.match(r"\x1b\[([0-9;?]*)([A-Za-z@`])", data[index:])
            if match is None:
                return index + 2
            params, final = match.group(1), match.group(2)
            self.csi(params, final)
            return index + len(match.group(0))
        if kind == "]":
            end = data.find("\x07", index)
            return len(data) if end < 0 else end + 1
        return index + 2

    def csi(self, params: str, final: str) -> None:
        clean = params.lstrip("?<>")
        parts = [int(part) if part.isdigit() else 0 for part in clean.split(";")] if clean else []
        first = parts[0] if parts else 0
        if final in "Hf":
            self.row = max(0, min(self.rows - 1, (parts[0] if parts and parts[0] else 1) - 1))
            self.col = max(0, min(self.cols - 1, (parts[1] if len(parts) > 1 and parts[1] else 1) - 1))
        elif final == "A":
            self.row = max(0, self.row - (first or 1))
        elif final == "B":
            self.row = min(self.rows - 1, self.row + (first or 1))
        elif final == "C":
            self.col = min(self.cols - 1, self.col + (first or 1))
        elif final == "D":
            self.col = max(0, self.col - (first or 1))
        elif final == "K":
            if first == 0:
                for col in range(self.col, self.cols):
                    self.grid[self.row][col] = Cell("", self.attr.fg, self.attr.bg)
            elif first == 1:
                for col in range(0, self.col + 1):
                    self.grid[self.row][col] = Cell("", self.attr.fg, self.attr.bg)
            else:
                for col in range(self.cols):
                    self.grid[self.row][col] = Cell("", self.attr.fg, self.attr.bg)
        elif final == "J":
            if first in (2, 3):
                self.blank()
            else:
                for row in range(self.row + 1, self.rows):
                    for col in range(self.cols):
                        self.grid[row][col] = Cell("", self.attr.fg, self.attr.bg)
                for col in range(self.col, self.cols):
                    self.grid[self.row][col] = Cell("", self.attr.fg, self.attr.bg)
        elif final == "m":
            self.sgr(parts)

    def sgr(self, parts: list[int]) -> None:
        if not parts:
            parts = [0]
        index = 0
        while index < len(parts):
            code = parts[index]
            if code == 0:
                self.attr = Attr()
            elif code == 1:
                self.attr.bold = True
            elif code == 2:
                self.attr.dim = True
            elif code == 22:
                self.attr.bold = False
                self.attr.dim = False
            elif code == 39:
                self.attr.fg = None
            elif code == 49:
                self.attr.bg = None
            elif code == 7:
                self.attr.fg, self.attr.bg = self.attr.bg, self.attr.fg
            elif code in (38, 48) and index + 1 < len(parts):
                mode = parts[index + 1]
                if mode == 2 and index + 4 < len(parts):
                    colour = (parts[index + 2], parts[index + 3], parts[index + 4])
                    index += 4
                elif mode == 5 and index + 2 < len(parts):
                    colour = CUBE[parts[index + 2] % 256]
                    index += 2
                else:
                    colour = None
                if colour is not None:
                    if code == 38:
                        self.attr.fg = colour
                    else:
                        self.attr.bg = colour
            index += 1


def build_cube() -> list[tuple[int, int, int]]:
    out = []
    for index in range(256):
        if index < 16:
            base = [(0, 0, 0), (128, 0, 0), (0, 128, 0), (128, 128, 0), (0, 0, 128), (128, 0, 128),
                    (0, 128, 128), (192, 192, 192), (128, 128, 128), (255, 0, 0), (0, 255, 0),
                    (255, 255, 0), (0, 0, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255)][index]
            out.append(base)
        elif index < 232:
            value = index - 16
            steps = [0, 95, 135, 175, 215, 255]
            out.append((steps[value // 36], steps[(value // 6) % 6], steps[value % 6]))
        else:
            grey = 8 + (index - 232) * 10
            out.append((grey, grey, grey))
    return out


CUBE = build_cube()

# ---------------------------------------------------------------- fonts


class Fonts:
    def __init__(self, size: int) -> None:
        self.mono = ImageFont.truetype(FONT_DIR, size, index=MONO_INDEX)
        self.symbols = [ImageFont.truetype(path, size) for path in SYMBOL_FONTS]
        self._cover: dict[str, ImageFont.FreeTypeFont] = {}

    def for_char(self, ch: str) -> ImageFont.FreeTypeFont:
        font = self._cover.get(ch)
        if font is None:
            font = self.mono
            for candidate in self.symbols:
                try:
                    if candidate.getmask(ch).getbbox() is not None:
                        font = candidate
                        break
                except Exception:
                    continue
            self._cover[ch] = font
        return font

class Coverage:
    """Codepoint coverage per font file, so missing glyphs fall back properly."""

    def __init__(self, fonts: Fonts) -> None:
        from fontTools.ttLib import TTCollection, TTFont

        self.sets: list[set[int]] = []
        collection = TTCollection(FONT_DIR)
        cmap = collection.fonts[MONO_INDEX].getBestCmap() or {}
        self.sets.append(set(cmap))
        for path in SYMBOL_FONTS:
            font = TTFont(path)
            self.sets.append(set(font.getBestCmap() or {}))

    def has(self, index: int, ch: str) -> bool:
        return ord(ch) in self.sets[index]


# ---------------------------------------------------------------- painting


def mix(colour: tuple[int, int, int], other: tuple[int, int, int], amount: float) -> tuple[int, int, int]:
    return tuple(int(round(a * (1 - amount) + b * amount)) for a, b in zip(colour, other))


def rounded(draw: ImageDraw.ImageDraw, box, radius: int, fill=None, outline=None, width: int = 1) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def whale(size: int) -> Image.Image:
    """A small cartoon whale, drawn at 4x and downsampled for clean edges."""
    scale = 4
    side = size * scale
    image = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    body = (86, 120, 255, 255)
    light = (140, 168, 255, 255)
    dark = (36, 52, 120, 255)
    # tail
    draw.polygon([(side * 0.30, side * 0.52), (side * 0.10, side * 0.36), (side * 0.14, side * 0.55),
                  (side * 0.10, side * 0.70), (side * 0.32, side * 0.60)], fill=body)
    # body
    draw.ellipse([side * 0.24, side * 0.38, side * 0.92, side * 0.78], fill=body)
    # belly
    draw.ellipse([side * 0.34, side * 0.58, side * 0.86, side * 0.79], fill=light)
    # spout
    for dx, dy, radius in ((0.60, 0.24, 0.055), (0.52, 0.16, 0.04), (0.68, 0.15, 0.04)):
        draw.ellipse([side * (dx - radius), side * (dy - radius), side * (dx + radius), side * (dy + radius)], fill=light)
    # eye
    draw.ellipse([side * 0.72, side * 0.50, side * 0.80, side * 0.58], fill=(250, 252, 255, 255))
    draw.ellipse([side * 0.745, side * 0.525, side * 0.785, side * 0.565], fill=dark)
    return image.resize((size, size), Image.LANCZOS)


@dataclass
class Timeline:
    captions: list[dict] = field(default_factory=list)
    chapters: list[dict] = field(default_factory=list)

    def current(self, entries: list[dict], t: float) -> str:
        text = ""
        for entry in entries:
            if entry["t"] / 1000 <= t:
                text = entry["text"]
        return text


def load_timeline() -> Timeline:
    data = json.loads((OUT / "captions.json").read_text())
    return Timeline(captions=data.get("captions", []), chapters=data.get("chapters", []))


def background() -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), (9, 12, 17))
    draw = ImageDraw.Draw(image)
    for y in range(HEIGHT):
        ratio = y / HEIGHT
        colour = mix((11, 14, 21), (17, 21, 31), ratio)
        draw.line([(0, y), (WIDTH, y)], fill=colour)
    glow = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([WIDTH * 0.18, -HEIGHT * 0.55, WIDTH * 0.82, HEIGHT * 0.85], fill=(60, 84, 180, 26))
    glow = glow.filter(ImageFilter.GaussianBlur(160))
    image = Image.alpha_composite(image.convert("RGBA"), glow).convert("RGB")
    return image


class Painter:
    def __init__(self, total: float) -> None:
        self.total = total
        self.base = background()
        self.mono = ImageFont.truetype(FONT_DIR, FONT_SIZE, index=MONO_INDEX)
        self.bold = False
        self.coverage = Coverage(Fonts(30))
        self.symbols = [ImageFont.truetype(path, FONT_SIZE) for path in SYMBOL_FONTS]
        self.ui = ImageFont.truetype(FONT_DIR, 30, index=2)
        self.ui_small = ImageFont.truetype(FONT_DIR, 20, index=2)
        self.ui_big = ImageFont.truetype(FONT_DIR, 96, index=2)
        self.ui_mid = ImageFont.truetype(FONT_DIR, 36, index=2)
        self.whale_cell = whale(30)
        self.whale_big = whale(180)
        self.row_cache: dict[tuple, Image.Image] = {}
        self.font_cache: dict[str, ImageFont.FreeTypeFont] = {}

    # -- glyph selection -------------------------------------------------
    def font_for(self, ch: str) -> ImageFont.FreeTypeFont:
        font = self.font_cache.get(ch)
        if font is not None:
            return font
        font = self.mono
        for index, candidate in enumerate(self.symbols, start=1):
            if self.coverage.has(index, ch):
                font = candidate
                break
        self.font_cache[ch] = font
        return font

    def cell_image(self, row: int, cells: list[Cell]) -> Image.Image:
        key = (row, tuple((c.ch, c.fg, c.bg, c.bold, c.dim) for c in cells))
        cached = self.row_cache.get(key)
        if cached is not None:
            return cached
        image = Image.new("RGB", (CONTENT_W, CELL_H), DEFAULT_BG)
        draw = ImageDraw.Draw(image)
        # background runs
        col = 0
        while col < len(cells):
            bg = cells[col].bg
            start = col
            while col < len(cells) and cells[col].bg == bg:
                col += 1
            if bg is not None and bg != DEFAULT_BG:
                draw.rectangle([start * CELL_W, 0, col * CELL_W - 1, CELL_H - 1], fill=bg)
        # text
        for index, cell in enumerate(cells):
            if cell.ch in (" ", ""):
                continue
            fg = cell.fg or DEFAULT_FG
            if cell.dim:
                fg = mix(fg, cell.bg or DEFAULT_BG, 0.42)
            if cell.ch == "🐳":
                image.paste(self.whale_cell, (index * CELL_W, 0), self.whale_cell)
                continue
            wide = is_wide(cell.ch)
            span = CELL_W * (2 if wide else 1)
            if wide:
                fg = cell.fg or DEFAULT_FG
            font = self.font_for(cell.ch)
            bbox = font.getbbox(cell.ch)
            glyph_w = bbox[2] - bbox[0]
            x = index * CELL_W + max(0, (span - glyph_w) / 2) - bbox[0]
            baseline = BASELINE
            if cell.bold:
                draw.text((x, baseline), cell.ch, font=font, fill=fg, anchor="ls", stroke_width=1, stroke_fill=fg)
            else:
                draw.text((x, baseline), cell.ch, font=font, fill=fg, anchor="ls")
        if len(self.row_cache) > 4000:
            self.row_cache.clear()
        self.row_cache[key] = image
        return image

    def paint(self, screen: Screen, t: float, timeline: Timeline) -> Image.Image:
        image = self.base.copy()
        draw = ImageDraw.Draw(image)
        # window
        draw.rounded_rectangle([WIN_X - 1, WIN_Y - 1, WIN_X + WIN_W + 1, WIN_Y + WIN_H + 1], radius=14, fill=(20, 25, 35))
        for index in range(ROWS):
            image.paste(self.cell_image(index, screen.grid[index]), (CONTENT_X, CONTENT_Y + index * CELL_H))
        # title bar
        draw.rectangle([WIN_X, WIN_Y, WIN_X + WIN_W, WIN_Y + TITLE_H], fill=(27, 33, 46))
        for offset, colour in ((0, (255, 95, 86)), (1, (255, 189, 46)), (2, (39, 201, 63))):
            cx = WIN_X + 22 + offset * 22
            draw.ellipse([cx - 6, WIN_Y + TITLE_H // 2 - 6, cx + 6, WIN_Y + TITLE_H // 2 + 6], fill=colour)
        draw.text((WIN_X + 96, WIN_Y + 12), "dshell — DeepSeek Harness", font=self.ui_small, fill=(150, 164, 190))
        chapter = timeline.current(timeline.chapters, t)
        if chapter:
            width = draw.textlength(chapter, font=self.ui_small)
            draw.text((WIN_X + WIN_W - 24 - width, WIN_Y + 12), chapter, font=self.ui_small, fill=(110, 124, 152))
        # captions
        caption = timeline.current(timeline.captions, t)
        if caption:
            draw.rectangle([WIN_X, 1006, WIN_X + 6, 1050], fill=ACCENT)
            draw.text((WIN_X + 22, 1012), caption, font=self.ui, fill=(210, 219, 236))
        # progress
        ratio = max(0.0, min(1.0, t / self.total))
        draw.rectangle([WIN_X, 1064, WIN_X + WIN_W, 1067], fill=(30, 37, 51))
        draw.rectangle([WIN_X, 1064, WIN_X + int(WIN_W * ratio), 1067], fill=ACCENT)
        return image

    def card(self, title: str, subtitle: str, lines: list[str], t: float, duration: float) -> Image.Image:
        image = self.base.copy()
        draw = ImageDraw.Draw(image)
        cx, cy = WIDTH // 2, 420
        big = self.whale_big
        image.paste(big, (cx - big.width // 2, cy - big.height // 2), big)
        draw.text((cx, cy + 150), title, font=self.ui_big, fill=(236, 241, 250), anchor="mt")
        draw.text((cx, cy + 280), subtitle, font=self.ui_mid, fill=(150, 166, 196), anchor="mt")
        y = cy + 370
        for line in lines:
            draw.text((cx, y), line, font=self.ui, fill=(122, 138, 168), anchor="mt")
            y += 52
        return image


# ---------------------------------------------------------------- driver

INTRO_SECONDS = 5.2
OUTRO_SECONDS = 8.0


def load_writes() -> tuple[list[dict], float]:
    writes = [json.loads(line) for line in (OUT / "frames.jsonl").read_text().splitlines() if line]
    meta = json.loads((OUT / "meta.json").read_text())
    return writes, meta["durationMs"] / 1000


def dump(times: list[float]) -> None:
    writes, _ = load_writes()
    screen = Screen(COLS, ROWS)
    index = 0
    for t in sorted(times):
        while index < len(writes) and writes[index]["t"] / 1000 <= t:
            screen.feed(writes[index]["chunk"])
            index += 1
        print(f"--- t={t:.1f}s")
        for row in screen.grid:
            print("".join(cell.ch or " " for cell in row).rstrip())


def grid_key(screen: Screen) -> tuple:
    return tuple((cell.ch, cell.fg, cell.bg, cell.bold, cell.dim) for row in screen.grid for cell in row)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dump", nargs="*", type=float, help="print the screen at these seconds")
    parser.add_argument("--frames", action="store_true", help="only write PNG frames")
    args = parser.parse_args()
    if args.dump:
        dump(args.dump)
        return 0

    writes, duration = load_writes()
    timeline = load_timeline()
    painter = Painter(duration)
    frames_dir = OUT / "frames"
    frames_dir.mkdir(exist_ok=True)
    for stale in frames_dir.glob("*.png"):
        stale.unlink()

    intro = painter.card(
        "dshell",
        "DeepSeek Harness 的终端前端",
        ["真流式 · 工具折叠 · 多端共享同一个会话"],
        0.0,
        duration,
    )
    outro = painter.card(
        "一个命令开始",
        "dshell",
        [
            "Enter 发送/插话 · Alt+Q 排队 · Ctrl-C 打断",
            "Alt+↑/↓ 选块 · Enter 详情 · Ctrl+O 展开工具输出",
            "github.com/Landasika/dshell",
        ],
        0.0,
        duration,
    )
    outro_start = max(0.0, duration - OUTRO_SECONDS)

    screen = Screen(COLS, ROWS)
    write_index = 0
    samples = int(duration * FPS) + 1
    last_key = None
    last_image = None
    sequence: list[tuple[str, float]] = []
    count = 0

    def emit(image: Image.Image, seconds: float) -> None:
        nonlocal count
        name = f"f{count:05d}.png"
        image.save(frames_dir / name)
        sequence.append((name, seconds))
        count += 1

    pending = 0
    for sample in range(samples):
        t = sample / FPS
        while write_index < len(writes) and writes[write_index]["t"] / 1000 <= t:
            screen.feed(writes[write_index]["chunk"])
            write_index += 1
        caption = timeline.current(timeline.captions, t)
        chapter = timeline.current(timeline.chapters, t)
        if t < INTRO_SECONDS:
            key = ("intro",)
        elif t >= outro_start:
            key = ("outro",)
        else:
            key = (caption, chapter, grid_key(screen))
        if key == last_key:
            pending += 1
            continue
        if last_image is not None and pending > 0:
            # Extend the previous frame instead of writing a duplicate.
            name, seconds = sequence[-1]
            sequence[-1] = (name, seconds + pending / FPS)
            pending = 0
        if key == ("intro",):
            image = intro
        elif key == ("outro",):
            image = outro
        else:
            image = painter.paint(screen, t, timeline)
        emit(image, 1 / FPS)
        last_key = key
        last_image = image
    if pending > 0 and sequence:
        name, seconds = sequence[-1]
        sequence[-1] = (name, seconds + pending / FPS)
    print(f"frames: {count}, duration {duration:.1f}s")

    listing = OUT / "frames.txt"
    lines = []
    for name, seconds in sequence:
        lines.append(f"file '{frames_dir / name}'")
        lines.append(f"duration {seconds:.3f}")
    lines.append(f"file '{frames_dir / sequence[-1][0]}'")
    listing.write_text("\n".join(lines) + "\n")

    if args.frames:
        return 0
    target = OUT / "dshell-promo.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", str(listing),
            "-fps_mode", "cfr", "-r", "30",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(target),
        ],
        check=True,
    )
    poster = OUT / "poster.png"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", "18", "-i", str(target), "-frames:v", "1", str(poster)],
        check=True,
    )
    print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
