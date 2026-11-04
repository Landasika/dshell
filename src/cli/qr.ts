/**
 * 二维码编码器（QR Code Model 2，字节模式，纠错等级 M）。
 *
 * ## 为什么自己写
 *
 * 上游的依赖只有 `yaml` 一个。为了画一张二维码引入 `qrcode`（连带 pngjs、
 * yargs 等 25 个包）不值得；而 `qrcode-terminal` 输出的是 ANSI 半块字符，
 * 手机摄像头扫不了——它给终端人眼看，我们要给摄像头看。
 *
 * 所以这里只实现编码这一半：文本 → 模块矩阵。渲染成 PNG 或终端字符由调用方
 * 决定（`renderPng` 在 qr.ts 里）。
 *
 * ## 实现范围
 *
 * - 字节模式（UTF-8），容量够放配对 URL
 * - 纠错等级 M（约 15% 冗余）：贴屏幕扫、有点反光也能读
 * - 版本 1–10 自动选（最多 213 字节，远超需要）
 * - 掩码按标准罚分选最优（不做这一步，某些数据会出大片同色块，扫不出来）
 *
 * GF(256) 与 RS 纠错是 QR 的数学底座，无法省略。
 */

/** GF(256) 指数/对数表，生成多项式 0x11d（QR 标准规定）。 */
import { deflateSync as zlibSync } from 'node:zlib'

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]
}

const gfMul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

/** RS 生成多项式：`(x - a^0)(x - a^1)...(x - a^(n-1))`。 */
function rsPoly(degree: number): number[] {
  let poly = [1]
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly = next
  }
  return poly
}

/** 计算一段数据的 RS 纠错码字。 */
function rsEncode(data: readonly number[], ecCount: number): number[] {
  const gen = rsPoly(ecCount)
  const result = new Array<number>(ecCount).fill(0)
  for (const byte of data) {
    const factor = byte ^ (result[0] as number)
    result.shift()
    result.push(0)
    for (let i = 0; i < ecCount; i += 1) {
      result[i] = (result[i] as number) ^ gfMul(gen[i + 1] as number, factor)
    }
  }
  return result
}

/** 每版本纠错等级 M 的块结构：`[块数, 总码字, 数据码字]`，可能有 2 段。 */
type RsGroup = readonly [count: number, total: number, data: number]
const RS_BLOCKS_M: readonly (readonly RsGroup[])[] = [
  [[1, 26, 16]],
  [[1, 44, 28]],
  [[1, 70, 44]],
  [[2, 50, 32]],
  [[2, 67, 43]],
  [[4, 43, 27]],
  [[4, 49, 31]],
  [[2, 60, 38], [2, 61, 39]],
  [[3, 58, 36], [2, 59, 37]],
  [[4, 69, 43], [1, 70, 44]],
  [[1, 80, 50], [4, 81, 51]],
  [[6, 58, 36], [2, 59, 37]],
  [[8, 59, 37], [1, 60, 38]],
  [[4, 64, 40], [5, 65, 41]],
  [[5, 65, 41], [5, 66, 42]],
  [[7, 73, 45], [3, 74, 46]],
  [[10, 74, 46], [1, 75, 47]],
  [[9, 69, 43], [4, 70, 44]],
  [[3, 70, 44], [11, 71, 45]],
  [[3, 67, 41], [13, 68, 42]],
  [[17, 68, 42]],
  [[17, 74, 46]],
  [[4, 75, 47], [14, 76, 48]],
  [[6, 73, 45], [14, 74, 46]],
  [[8, 75, 47], [13, 76, 48]],
  [[19, 74, 46], [4, 75, 47]],
  [[22, 73, 45], [3, 74, 46]],
  [[3, 73, 45], [23, 74, 46]],
  [[21, 73, 45], [7, 74, 46]],
  [[19, 75, 47], [10, 76, 48]],
  [[2, 74, 46], [29, 75, 47]],
  [[10, 74, 46], [23, 75, 47]],
  [[14, 74, 46], [21, 75, 47]],
  [[14, 74, 46], [23, 75, 47]],
  [[12, 75, 47], [26, 76, 48]],
  [[6, 75, 47], [34, 76, 48]],
  [[29, 74, 46], [14, 75, 47]],
  [[13, 74, 46], [32, 75, 47]],
  [[40, 75, 47], [7, 76, 48]],
  [[18, 75, 47], [31, 76, 48]],
]

/** 各版本纠错等级 M 的数据码字总数（由表推出，避免手抄出错）。 */
const DATA_CODEWORDS_M: number[] = RS_BLOCKS_M.map((groups) =>
  groups.reduce((sum, [count, , data]) => sum + count * data, 0))

/**
 * 对齐图形中心坐标表（版本 1–10，索引 = 版本 - 1）。
 *
 * 版本 1 没有对齐图形（只有三个定位图形），所以首项为空。
 * 注意别多写一个空项——那样 v2 会取到空表，对齐图形整个不画，
 * 码看起来"正常"但扫码器读不出来。
 */
const ALIGN_POSITIONS: readonly (readonly number[])[] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
]

/** 一个版本的模块矩阵。`true` 表示黑。 */
export interface QrMatrix {
  size: number
  dark(row: number, col: number): boolean
}

/** 编码结果：版本 + 掩码 + 矩阵。 */
export interface QrCode extends QrMatrix {
  version: number
  mask: number
}

/** 一段数据的比特缓冲区。 */
class BitBuffer {
  readonly bits: number[] = []

  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1)
  }
}

/**
 * 编码一段文本。
 *
 * 版本按内容长度自动选：从 1 往上找到第一个装得下的。数据短时用小版本，
 * 模块少、格子大、更好扫。
 */
export function encodeQr(text: string, minVersion = 1): QrCode {
  const bytes = [...Buffer.from(text, 'utf8')]
  let version = Math.max(1, minVersion)
  for (; version <= 10; version += 1) {
    // 字节模式头 4 bit + 长度字段（版本 10 起 16 bit）+ 数据
    const lengthBits = version < 10 ? 8 : 16
    if (bytes.length * 8 + 4 + lengthBits <= (DATA_CODEWORDS_M[version - 1] as number) * 8) break
  }
  if (version > 10) throw new Error('二维码内容过长')

  const dataCodewords = DATA_CODEWORDS_M[version - 1] as number
  const buffer = new BitBuffer()
  buffer.put(0b0100, 4) // 字节模式
  buffer.put(bytes.length, version < 10 ? 8 : 16)
  for (const byte of bytes) buffer.put(byte, 8)
  // 终止符 + 补齐到字节边界
  const capacityBits = dataCodewords * 8
  buffer.put(0, Math.min(4, capacityBits - buffer.bits.length))
  while (buffer.bits.length % 8 !== 0) buffer.bits.push(0)
  // 交替填充 0xEC / 0x11（标准规定的填充字节）
  const dataCw: number[] = []
  for (let i = 0; i < buffer.bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (buffer.bits[i + j] as number)
    dataCw.push(byte)
  }
  for (let pad = 0xec; dataCw.length < dataCodewords; pad = pad === 0xec ? 0x11 : 0xec) {
    dataCw.push(pad)
  }

  // 分块、算纠错、交织
  const groups = RS_BLOCKS_M[version - 1] as readonly RsGroup[]
  const allCw: number[] = []
  const ecCw: number[] = []
  let offset = 0
  for (const [count, total, dataLen] of groups) {
    const ecLen = total - dataLen
    for (let i = 0; i < count; i += 1) {
      const chunk = dataCw.slice(offset, offset + dataLen)
      offset += dataLen
      allCw.push(...chunk)
      ecCw.push(...rsEncode(chunk, ecLen))
    }
  }
  // 交织：数据码字按列取
  const maxData = Math.max(...groups.map(([, , dataLen]) => dataLen))
  const maxEc = Math.max(...groups.map(([, total, dataLen]) => total - dataLen))
  const blocks: number[][] = []
  let cursor = 0
  for (const [count, , dataLen] of groups) {
    for (let i = 0; i < count; i += 1) {
      blocks.push(allCw.slice(cursor, cursor + dataLen))
      cursor += dataLen
    }
  }
  const ecBlocks: number[][] = []
  cursor = 0
  for (const [count, total, dataLen] of groups) {
    const ecLen = total - dataLen
    for (let i = 0; i < count; i += 1) {
      ecBlocks.push(ecCw.slice(cursor, cursor + ecLen))
      cursor += ecLen
    }
  }
  const final: number[] = []
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.length) final.push(block[i] as number)
  }
  for (let i = 0; i < maxEc; i += 1) {
    for (const block of ecBlocks) if (i < block.length) final.push(block[i] as number)
  }

  // 选罚分最低的掩码
  let best: { matrix: QrMatrix; mask: number; penalty: number } | undefined
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = buildMatrix(version, final, mask)
    const penalty = penaltyOf(matrix)
    if (best === undefined || penalty < best.penalty) best = { matrix, mask, penalty }
  }
  const chosen = best as { matrix: QrMatrix; mask: number; penalty: number }
  return Object.assign(chosen.matrix, { version, mask: chosen.mask })
}

/** 按掩码规则翻转数据区，并放置功能图形。 */
function buildMatrix(version: number, codewords: readonly number[], mask: number): QrMatrix {
  const size = version * 4 + 17
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))

  const set = (row: number, col: number, dark: boolean): void => {
    modules[row]![col] = dark
    reserved[row]![col] = true
  }

  // 定位图形（三个角）
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const row = r0 + r
        const col = c0 + c
        if (row < 0 || row >= size || col < 0 || col >= size) continue
        const onEdge = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6))
        const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4
        set(row, col, onEdge || inner)
      }
    }
  }

  // 对齐图形
  for (const row of ALIGN_POSITIONS[version - 1] ?? []) {
    for (const col of ALIGN_POSITIONS[version - 1] ?? []) {
      // 与三个定位图形重叠的位置不画对齐图形（标准规定）
      if (reserved[row]![col]) continue
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const ring = Math.max(Math.abs(r), Math.abs(c))
          set(row + r, col + c, ring !== 1)
        }
      }
    }
  }

  // 定时图形
  for (let i = 8; i < size - 8; i += 1) {
    if (!reserved[6]![i]) set(6, i, i % 2 === 0)
    if (!reserved[i]![6]) set(i, 6, i % 2 === 0)
  }

  // 格式信息占位（先占位，最后写真实值）
  for (let i = 0; i < 9; i += 1) {
    if (!reserved[8]![i]) reserved[8]![i] = true
    if (!reserved[i]![8]) reserved[i]![8] = true
  }
  for (let i = 0; i < 8; i += 1) {
    if (!reserved[8]![size - 1 - i]) reserved[8]![size - 1 - i] = true
    if (!reserved[size - 1 - i]![8]) reserved[size - 1 - i]![8] = true
  }
  set(size - 8, 8, true) // 固定黑点

  /**
   * 版本块必须先预留再填数据。
   *
   * v7 起的版本信息位落在数据区路径上：如果只"最后写一遍"而不先占用，
   * 数据填充会把码字写进这 36 个格子，版本信息覆盖上去后码字就错了——
   * 症状是 v1–v6 全好、v7 起读不出来。
   */
  if (version >= 7) {
    const versionBits = bchVersion(version)
    for (let i = 0; i < 18; i += 1) {
      const bit = ((versionBits >>> i) & 1) === 1
      set(Math.floor(i / 3), (i % 3) + size - 11, bit)
      set((i % 3) + size - 11, Math.floor(i / 3), bit)
    }
  }

  // 数据区：从右下往上，两列一组，蛇形
  let bitIndex = 0
  const totalBits = codewords.length * 8
  const nextBit = (): boolean => {
    if (bitIndex >= totalBits) return false
    const byte = codewords[bitIndex >> 3] as number
    const bit = ((byte >>> (7 - (bitIndex & 7))) & 1) === 1
    bitIndex += 1
    return bit
  }
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1 // 跳过定时列
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j
        const upward = ((right + 1) & 2) === 0
        const row = upward ? size - 1 - vertical : vertical
        if (reserved[row]![col]) continue
        const raw = nextBit()
        modules[row]![col] = maskBit(mask, row, col) ? !raw : raw
      }
    }
  }

  /**
   * 写格式信息。
   *
   * 15 位要分两处写：一处沿第 8 列竖向铺开（左上角），一处沿第 8 行横向铺开。
   * 两处都能独立解出来，读码器任取其一——但位置必须精确，错一格整张码就读不出。
   * 下面两个循环的 index 映射照 QR 标准（ISO/IEC 18004 图 25）。
   */
  const data = (0b00 << 3) | mask // 纠错等级 M = 0b00
  const format = bchFormat(data) ^ 0b101010000010010
  for (let v = 0; v < 15; v += 1) {
    const bit = ((format >>> v) & 1) === 1
    if (v < 6) modules[v]![8] = bit
    else if (v < 8) modules[v + 1]![8] = bit
    else modules[size - 15 + v]![8] = bit
  }
  for (let h = 0; h < 15; h += 1) {
    const bit = ((format >>> h) & 1) === 1
    if (h < 8) modules[8]![size - h - 1] = bit
    else if (h < 9) modules[8]![15 - h] = bit
    else modules[8]![15 - h - 1] = bit
  }
  modules[size - 8]![8] = true

  return { size, dark: (row: number, col: number) => modules[row]![col] === true }
}

/** 掩码规则（标准表 10）。 */
function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0
    case 1: return row % 2 === 0
    case 2: return col % 3 === 0
    case 3: return (row + col) % 3 === 0
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
  }
}

/** 版本信息的 BCH(18,6) 校验位。 */
function bchVersion(version: number): number {
  let value = version << 12
  for (let i = 17; i >= 12; i -= 1) {
    if (((value >>> i) & 1) === 1) value ^= 0b1111100100101 << (i - 12)
  }
  return (version << 12) | value
}

/** 格式信息的 BCH(15,5) 校验位。 */
function bchFormat(data: number): number {
  let value = data << 10
  for (let i = 14; i >= 10; i -= 1) {
    if (((value >>> i) & 1) === 1) value ^= 0b10100110111 << (i - 10)
  }
  return (data << 10) | value
}

/**
 * 掩码罚分（标准表 11 的四条规则）。
 *
 * 不做这步也能出图，但某些输入会生成大片同色区域或假定位图形，
 * 手机可能扫不出来。四条规则分别针对：长同色段、2×2 同色块、
 * 类似定位图形的 1:1:3:1:1 图案、黑白比例失衡。
 */
function penaltyOf(matrix: QrMatrix): number {
  const { size } = matrix
  let penalty = 0
  const at = (r: number, c: number): boolean => matrix.dark(r, c)

  // 规则 1：行/列连续同色 ≥5
  for (let i = 0; i < size; i += 1) {
    for (const horizontal of [true, false]) {
      let run = 1
      for (let j = 1; j < size; j += 1) {
        const prev = horizontal ? at(i, j - 1) : at(j - 1, i)
        const curr = horizontal ? at(i, j) : at(j, i)
        if (curr === prev) {
          run += 1
        } else {
          if (run >= 5) penalty += run - 2
          run = 1
        }
      }
      if (run >= 5) penalty += run - 2
    }
  }

  // 规则 2：2×2 同色块
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = at(r, c)
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) penalty += 3
    }
  }

  // 规则 3：1:1:3:1:1 类似定位图形
  const pattern = [true, false, true, true, true, false, true]
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c + 6 < size; c += 1) {
      let hit = true
      for (let k = 0; k < 7; k += 1) if (at(r, c + k) !== pattern[k]) { hit = false; break }
      if (hit) penalty += 40
    }
  }
  for (let c = 0; c < size; c += 1) {
    for (let r = 0; r + 6 < size; r += 1) {
      let hit = true
      for (let k = 0; k < 7; k += 1) if (at(r + k, c) !== pattern[k]) { hit = false; break }
      if (hit) penalty += 40
    }
  }

  // 规则 4：黑白比例
  let dark = 0
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) if (at(r, c)) dark += 1
  const ratio = (dark * 100) / (size * size)
  penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10
  return penalty
}

/**
 * 渲染成 PNG。
 *
 * 自己写 PNG 编码：只需要「灰度、无压缩存储」这一种最简形式，几十行就够，
 * 不值得为此引入 pngjs。手机扫码要的是位图，终端字符它读不了。
 *
 * 用 4 倍模块尺寸 + 4 模块静区：静区是标准要求的白边，缺了扫码器找不到边界。
 */
export function renderPng(qr: QrMatrix, scale = 8, quiet = 4): Buffer {
  const dimension = (qr.size + quiet * 2) * scale
  // 每行 1 字节滤波类型 + dimension 字节灰度
  const stride = dimension + 1
  const raw = Buffer.alloc(stride * dimension, 0xff)
  for (let y = 0; y < dimension; y += 1) {
    raw[y * stride] = 0 // 滤波类型 None
    for (let x = 0; x < dimension; x += 1) {
      const mx = Math.floor(x / scale) - quiet
      const my = Math.floor(y / scale) - quiet
      const dark = mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.dark(my, mx)
      raw[y * stride + 1 + x] = dark ? 0x00 : 0xff
    }
  }

  const deflated = zlibSync(raw)
  const chunks: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length)
    const tagged = Buffer.concat([Buffer.from(type, 'latin1'), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(tagged) >>> 0)
    return Buffer.concat([length, tagged, crc])
  }
  // IHDR：宽、高、8 位深、灰度（类型 0）、无交错
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(dimension, 0)
  ihdr.writeUInt32BE(dimension, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  chunks.push(chunk('IHDR', ihdr))
  chunks.push(chunk('IDAT', deflated))
  chunks.push(chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = -1
  for (const byte of buffer) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] as number)
  return crc ^ -1
}

/**
 * 渲染成终端可视的字符。
 *
 * 用两个半块字符（`▀`/`▄`/`█`）把上下两行合成一行，这样二维码在终端里
 * 是"方"的——直接用单字符会让高宽比变成 2:1，摄像头扫不出来。
 */
export function renderTerminal(qr: QrMatrix, quiet = 2): string {
  const lines: string[] = []
  const dark = (row: number, col: number): boolean =>
    row >= 0 && col >= 0 && row < qr.size && col < qr.size && qr.dark(row, col)
  for (let row = -quiet; row < qr.size + quiet; row += 2) {
    let line = ''
    for (let col = -quiet; col < qr.size + quiet; col += 1) {
      const top = dark(row, col)
      const bottom = dark(row + 1, col)
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines.join('\n')
}
