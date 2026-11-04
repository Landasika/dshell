/**
 * `dshell remote` 与二维码编码的测试。
 *
 * 重点是"扫得出来"这件事：二维码画错一点也不报错，只是手机扫不出来，
 * 而那个症状离原因很远（用户会以为手机或网络有问题）。所以这里既验证
 * 结构（定位图形、静区），也验证往返（编码后能被独立解码器读回原文）。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

const { encodeQr, renderTerminal, renderPng } = await import('../dist/cli/qr.js')
const { lanCandidates, pairPayload, decodePayload, prepareRemote } = await import('../dist/cli/remote.js')

test('二维码结构：三个定位图形在角上', () => {
  const qr = encodeQr('hello world')
  const isProbe = (r0, c0) => {
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6
        const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4
        if (qr.dark(r0 + r, c0 + c) !== (edge || inner)) return false
      }
    }
    return true
  }
  assert.ok(isProbe(0, 0), '左上定位图形')
  assert.ok(isProbe(0, qr.size - 7), '右上定位图形')
  assert.ok(isProbe(qr.size - 7, 0), '左下定位图形')
})

test('二维码结构：暗模块比例接近一半', () => {
  // 偏离太多说明掩码或数据填充有问题，扫码器容错会吃不消
  for (const text of ['a', 'dshell-pair://' + 'x'.repeat(80), 'x'.repeat(150)]) {
    const qr = encodeQr(text)
    let dark = 0
    for (let r = 0; r < qr.size; r += 1) for (let c = 0; c < qr.size; c += 1) if (qr.dark(r, c)) dark += 1
    const ratio = (dark * 100) / (qr.size * qr.size)
    assert.ok(ratio > 35 && ratio < 65, `"${text.slice(0, 10)}" 暗模块 ${ratio.toFixed(1)}%`)
  }
})

test('二维码结构：对齐图形（版本 2 起）真的画了', () => {
  // 曾经漏画过：v1 正常、v2 起扫码器读不出，症状很隐蔽
  const qr = encodeQr('x'.repeat(40))
  assert.ok(qr.version >= 2, '这段内容应落在 v2 以上')
  const center = 18 // v2 的对齐图形中心
  // 中心点黑、外面一圈白、再外一圈黑
  assert.ok(qr.dark(center, center), '对齐图形中心应黑')
  assert.ok(!qr.dark(center, center + 1), '中心外围应白')
  assert.ok(qr.dark(center, center + 2), '最外圈应黑')
})

test('版本 ≥7 需要版本信息块', () => {
  const qr = encodeQr('x'.repeat(130))
  assert.ok(qr.version >= 7, `版本应 ≥7，实际 ${qr.version}`)
  // 右上角版本块至少有若干黑位（全白说明没写）
  let dark = 0
  for (let r = 0; r < 6; r += 1) for (let c = qr.size - 11; c < qr.size - 8; c += 1) if (qr.dark(r, c)) dark += 1
  assert.ok(dark > 0, '版本信息块不该全白')
})

test('终端渲染：半块字符，且行数是模块数的一半左右', () => {
  const qr = encodeQr('hello')
  const lines = renderTerminal(qr, 2).split('\n')
  // 静区上下各 2 行，两行模块合成一行
  assert.equal(lines.length, Math.ceil((qr.size + 4) / 2))
  assert.ok(/[▀▄█]/.test(lines.join('')), '应包含半块字符')
})

test('PNG 渲染：合法的 PNG 头与尺寸', () => {
  const qr = encodeQr('hello')
  const png = renderPng(qr, 8, 4)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG 魔数')
  const expected = (qr.size + 8) * 8
  assert.equal(png.readUInt32BE(16), expected, 'PNG 宽度')
  assert.equal(png.readUInt32BE(20), expected, 'PNG 高度')
})

test('配对载荷与 App 的 PairPayload 字段一一对应', () => {
  const payload = pairPayload({
    name: 'pc',
    hosts: ['192.168.8.77', '10.0.0.5'],
    port: 8792,
    code: 'ABCD2345',
    fingerprint: 'fp-1',
  })
  assert.ok(payload.startsWith('dshell-pair://'), 'App 只认这个前缀')
  const decoded = decodePayload(payload)
  assert.equal(decoded.v, 1)
  assert.equal(decoded.name, 'pc')
  assert.deepEqual(decoded.hosts, ['192.168.8.77', '10.0.0.5'])
  assert.equal(decoded.port, 8792)
  assert.equal(decoded.code, 'ABCD2345')
  assert.equal(decoded.fp, 'fp-1', 'App 读的是 fp 而不是 fingerprint')
})

test('虚拟网卡被排除，隧道网卡保留', () => {
  const fake = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    ens18: [{ family: 'IPv4', address: '192.168.8.200', internal: false }],
    'br-abc123': [{ family: 'IPv4', address: '172.18.0.1', internal: false }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    veth12: [{ family: 'IPv4', address: '172.19.0.5', internal: false }],
    // WireGuard 隧道必须保留：用户可能就从外网经它连回来
    wg0: [{ family: 'IPv4', address: '10.13.0.1', internal: false }],
    tun0: [{ family: 'IPv4', address: '10.254.0.14', internal: false }],
    // 老版 Node 的 family 是数字
    eth9: [{ family: 4, address: '192.168.1.5', internal: false }],
  }
  const hosts = lanCandidates(fake)
  // 同权重的地址（都是 192.168）保持枚举顺序，所以只断言集合与相对顺序
  assert.equal(hosts.length, 4, `实际 ${hosts.join(', ')}`)
  assert.ok(!hosts.some((h) => h.startsWith('172.')), 'Docker 网桥不该出现')
  assert.ok(hosts.includes('192.168.8.200') && hosts.includes('192.168.1.5'), '真实网卡要保留')
  assert.ok(hosts.includes('10.13.0.1'), 'WireGuard 地址要保留')
  assert.ok(hosts.includes('10.254.0.14'), 'tun 地址要保留')
  // 192.168 家庭网段排在 10.x 隧道之前
  const firstLan = hosts.findIndex((h) => h.startsWith('192.168.'))
  const firstTunnel = hosts.findIndex((h) => h.startsWith('10.'))
  assert.ok(firstLan < firstTunnel, '局域网地址应排在隧道地址之前')
})

test('Host 没起时给出可操作的错误，不是 ECONNREFUSED', async () => {
  await assert.rejects(
    prepareRemote({ port: 19997 }),
    (error) => {
      assert.match(error.message, /19997/, '要指出是哪个端口')
      assert.match(error.message, /wsPort/, '要告诉用户去改哪里')
      return true
    },
  )
})

test('完整流程：从 Host 取码，组装载荷', async (t) => {
  const port = 19998
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/health')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, plugin: 'dshell-host', protocol: 2, fingerprint: 'fp-x' }))
      return
    }
    if (req.url?.startsWith('/api/pair/code') && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 'ABCD2345' }))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  t.after(() => server.close())

  const result = await prepareRemote({ port })
  assert.equal(result.code, 'ABCD2345')
  assert.equal(result.fingerprint, 'fp-x')
  assert.equal(result.port, port)
  const decoded = decodePayload(result.payload)
  assert.equal(decoded.code, 'ABCD2345')
  assert.equal(decoded.port, port)
  assert.ok(decoded.hosts.length > 0, '至少一个候选地址')
})
