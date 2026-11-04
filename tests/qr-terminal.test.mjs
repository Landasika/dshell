import assert from 'node:assert/strict'
import test from 'node:test'

import { encodeQr, renderTerminal } from '../dist/cli/qr.js'

/**
 * 终端二维码的**极性**契约。
 *
 * 这一组用例存在的原因：曾经有个版本在深色终端下发出的是反色码，
 * 而 zxing 默认不认反色，导致手机"怎么扫都扫不上"。用户反馈时说的是
 * "码太密/太小"，实际和尺寸无关——**颜色极性**才是根因。
 *
 * 半块字符画的是前景色、空格露出背景色，所以二维码的黑白完全取决于
 * 终端主题。深色终端（黑底白字）会把黑块画成白色，等价于反色码。
 * 修法是渲染时用 ANSI 显式锁死"黑字 + 白底"。
 */

const STRIP = /\u001b\[[0-9;]*m/g

test('终端二维码强制黑字白底，不随终端主题反转', () => {
  const out = renderTerminal(encodeQr('hello'), 2)
  assert.match(out, /\u001b\[30m/, '必须显式指定黑色前景')
  assert.match(out, /\u001b\[107m/, '必须显式指定亮白背景')
  assert.match(out, /\u001b\[0m/, '必须有重置，否则污染后续输出')
})

test('每行都单独开始和结束颜色，不会漏到下一行', () => {
  // 只在开头设一次颜色的话，中途换行后背景会断掉，扫码同样失败
  const lines = renderTerminal(encodeQr('hello'), 2).split('\n')
  assert.ok(lines.length > 3)
  for (const [i, line] of lines.entries()) {
    assert.ok(line.startsWith('\u001b[107m\u001b[30m'), `第 ${i} 行缺少起始配色`)
    assert.ok(line.endsWith('\u001b[0m'), `第 ${i} 行缺少重置`)
  }
})

test('关掉颜色时输出纯字符（测试/无 ANSI 环境用）', () => {
  const out = renderTerminal(encodeQr('hello'), 2, false)
  assert.ok(!out.includes('\u001b['), 'forceColor=false 时不应有转义序列')
  assert.match(out, /[▀▄█]/)
})

test('剥掉 ANSI 后仍是标准二维码形状（方、有静区）', () => {
  const lines = renderTerminal(encodeQr('hello'), 2).split('\n').map((l) => l.replace(STRIP, ''))
  const cols = lines[0].length
  // 半块字符把两行合成一行，所以行数约为列数的一半；太扁就扫不出
  assert.ok(lines.length >= cols / 2 - 2, `行数 ${lines.length} 对列数 ${cols} 太扁`)
  // 顶部和底部各留 1 行静区（quiet=2 → 2 行模块 → 1 行字符）
  assert.equal(lines[0].trim(), '', '顶部应有静区')
  assert.equal(lines.at(-1).trim(), '', '底部应有静区')
})

test('静区宽度可调，默认两侧各留 2 模块', () => {
  const withQuiet = renderTerminal(encodeQr('hello'), 2, false).split('\n')[0]
  const noQuiet = renderTerminal(encodeQr('hello'), 0, false).split('\n')[0]
  assert.ok(withQuiet.length > noQuiet.length, 'quiet 越大，左右留白越宽')
})
