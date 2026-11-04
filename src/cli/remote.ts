/**
 * `dshell remote`：把手机接进来的入口。
 *
 * ## 它解决的两个痛点
 *
 * 1. **手输地址 + 配对码容易错**。手机要和电脑在同一网段、要知道 IP、要抄
 *    8 位码——每一步都可能出岔子，而错了只看到"连不上"。这里把三样东西
 *    （候选地址、端口、配对码）编码进一张二维码，扫一下就完事。
 *
 * 2. **多网卡时不知道该填哪张网卡的地址**。笔记本同时有 Wi-Fi、有线、
 *    WireGuard 隧道时，用户根本不知道手机该走哪个。这里把探测到的地址
 *    全列进二维码，App 自己去探哪个通。
 *
 * ## 为什么设备表能免重配
 *
 * token 存在 `$DSH_HOME/dshell-ws/devices.json`（0600，只存 sha256），
 * 是磁盘文件而不是进程内存。dsh 重启后同一台手机仍带着旧 token，直接就能连——
 * **配对一次，长期有效**，除非用户主动撤销或换了机器。
 */
import { request as httpRequest } from 'node:http'
import { writeFileSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'

import { encodeQr, renderPng, renderTerminal } from './qr.js'

export interface RemoteOptions {
  /** WebSocket 端口，和 dshell-host 的 `wsPort` 一致。 */
  port: number
  /** 只打印二维码数据，不打印图形（给脚本用）。 */
  quiet?: boolean
  /** 把二维码存成 PNG 的路径。 */
  png?: string
  /** 配对码有效期（秒），仅用于文案提示。 */
  ttlSeconds?: number
}

export interface RemoteResult {
  code: string
  hosts: string[]
  port: number
  /** 二维码里的完整载荷。 */
  payload: string
  fingerprint: string
  name: string
}

/**
 * 列出本机所有可能的 IPv4 地址，供手机尝试。
 *
 * 排序不是随意的：家庭/办公局域网最常见，排前面让 App 先探，
 * 成功概率高的先试。隧道地址（WireGuard 常是 10.x）排后面。
 */
export function lanCandidates(interfaces = networkInterfaces()): string[] {
  const found: string[] = []
  for (const [name, list] of Object.entries(interfaces)) {
    /**
     * 虚拟网卡一律排除。
     *
     * 这台机器上有 12 个 Docker 网桥（br-xxx），每个都有一个 172.x 地址。
     * 把它们列进二维码不是"多给几个选项"，而是**主动误导**：手机在局域网里
     * 根本路由不到这些地址，App 逐个探测会多花好几秒，最后才试到真的那个。
     * 用户看到的是"配对很慢"，很难联想到是虚拟机网桥。
     */
    if (isVirtualInterface(name)) continue
    for (const entry of list ?? []) {
      // family 在新版 Node 是字符串 'IPv4'，老版是数字 4，两种都认
      const family = entry.family as string | number
      if ((family === 'IPv4' || family === 4) && !entry.internal) found.push(entry.address)
    }
  }
  const rank = (address: string): number => {
    if (address.startsWith('192.168.')) return 0 // 家用最常见
    if (address.startsWith('10.')) return 2 // 常见于 VPN 隧道
    if (address.startsWith('172.')) return 1 // Docker/企业网
    return 3
  }
  return found.sort((a, b) => rank(a) - rank(b))
}

/**
 * 这个名字的网卡是不是虚拟的。
 *
 * 按名字判断而不是按地址段：Docker 网桥可能是 172.x、10.x 或任何自定义段，
 * 而真正对外的网卡也可能落在 10.x（企业网很常见）。名字是可靠的信号。
 */
function isVirtualInterface(name: string): boolean {
  return (
    name === 'lo' ||
    name.startsWith('br-') || // Docker bridge
    name.startsWith('veth') || // 容器网卡
    name.startsWith('docker') ||
    name.startsWith('virbr') || // libvirt
    name.startsWith('vmnet') || // VMware
    name.startsWith('vboxnet') // VirtualBox
    // 注意：tun0 / wg0 **不能**排除——用户可能就用 WireGuard 或 tun 隧道
    // 从外网连回来，那正是"不在同一局域网也能配对"的场景。
  )
}

/** 向本机 Host 要一个配对码。只走回环——服务端也只接受回环。 */
async function requestCode(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/api/pair/code', method: 'POST', timeout: 5000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) {
            reject(new Error(describeFailure(res.statusCode ?? 0, text)))
            return
          }
          try {
            const parsed = JSON.parse(text) as { code?: unknown }
            const code = typeof parsed.code === 'string' ? parsed.code : ''
            if (code.length === 0) {
              reject(new Error('Host 没有返回配对码'))
              return
            }
            resolve(code)
          } catch {
            reject(new Error('Host 返回的不是 JSON'))
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`连不上 127.0.0.1:${String(port)}（超时）`))
    })
    req.on('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ECONNREFUSED' ? new Error(notRunning(port)) : error)
    })
    req.end()
  })
}

function notRunning(port: number): string {
  return [
    `127.0.0.1:${String(port)} 上没有服务在听。`,
    '',
    '手机要通过 WebSocket 连进来，这个端口得先开起来。检查两处：',
    `  1. dshell profile 的配置里有 wsPort: ${String(port)}`,
    '     （在 ~/.dsh/profiles/dshell/cordis.patch.yml）',
    '  2. Host 进程正在跑：systemctl --user status dsh-host',
    '',
    '配好之后重启一次 Host 就会生效。',
  ].join('\n')
}

function describeFailure(status: number, body: string): string {
  let code = ''
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    if (typeof parsed.error === 'string') code = parsed.error
  } catch {
    // 非 JSON，保持空
  }
  if (code === 'LOOPBACK_ONLY') return '配对码只能在电脑本机生成'
  if (status === 404) return '这个端口上的服务不支持配对（可能不是 dshell-host）'
  return `Host 拒绝签发配对码（HTTP ${String(status)}${code.length > 0 ? ` ${code}` : ''}）`
}

/** 探测端口上是不是我们的 Host。 */
async function probeHealth(port: number): Promise<{ ok: boolean; fingerprint?: string }> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: 3000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              plugin?: unknown
              fingerprint?: unknown
            }
            resolve({
              ok: parsed.plugin === 'dshell-host',
              ...(typeof parsed.fingerprint === 'string' ? { fingerprint: parsed.fingerprint } : {}),
            })
          } catch {
            resolve({ ok: false })
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false })
    })
    req.on('error', () => resolve({ ok: false }))
    req.end()
  })
}

/** 组装二维码载荷。与 App 的 `PairPayload.parse` 一一对应。 */
/**
 * 配对二维码的载荷。
 *
 * ## 为什么不用 base64(JSON)
 *
 * 二维码的密度直接决定能不能扫上：手机对着电脑屏幕拍，模块越小越难解。
 * 原先用 base64(JSON)，光是把 JSON 转成 base64 就撑大 33%，再加上字段名
 * `{"v":1,"name":"...","hosts":[...],...}`，158 字符 → **版本 9、53×53 模块**，
 * 终端渲染出来 57 列×29 行。真机上手机几乎扫不动。
 *
 * 现在换成紧凑的竖线分隔格式（`hosts>port>code>fp>name`），同样三个地址
 * 只要 63 字符 → 版本 5、37×37 模块，小了一半，扫码明显容易。
 *
 * ## 格式
 *
 * ```
 * dshell-pair://<hosts>|<port>|<code>|<fp>|<name>
 * ```
 *  - `hosts` 用逗号分隔（IPv4 / 主机名，不含端口）
 *  - 后四个字段固定位置；`fp` 和 `name` 可以为空，但要保留分隔符，这样
 *    "第几段是什么"永远是确定的，不用靠猜
 *  - 竖线和逗号不会出现在 IPv4 / 主机名 / 配对码里（码的字母表是
 *    `ABCDEFGHJKMNPQRSTUVWXYZ23456789`），所以不需要转义
 *
 * 解析端仍然兼容旧的 base64(JSON)：手里的旧二维码还没过期时扫它照样能配对。
 */
export function pairPayload(input: {
  name: string
  hosts: readonly string[]
  port: number
  code: string
  fingerprint: string
}): string {
  const parts = [
    [...input.hosts].join(','),
    String(input.port),
    input.code,
    input.fingerprint,
    input.name,
  ]
  return `dshell-pair://${parts.join('|')}`
}

/** 跑一次配对流程。 */
export async function prepareRemote(options: RemoteOptions): Promise<RemoteResult> {
  const health = await probeHealth(options.port)
  if (!health.ok) throw new Error(notRunning(options.port))

  const code = await requestCode(options.port)
  const hosts = lanCandidates()
  if (hosts.length === 0) {
    throw new Error('这台机器没有可用的局域网地址（只连了回环）。手机连不进来。')
  }
  const name = hostnameOrFallback()
  const fingerprint = health.fingerprint ?? ''
  const payload = pairPayload({ name, hosts, port: options.port, code, fingerprint })
  return { code, hosts, port: options.port, payload, fingerprint, name }
}

function hostnameOrFallback(): string {
  try {
    return hostname()
  } catch {
    return 'dshell'
  }
}

/** 打印配对界面。 */
export function printRemote(result: RemoteResult, options: RemoteOptions = { port: result.port }): void {
  const ttl = options.ttlSeconds ?? 300
  const minutes = Math.round(ttl / 60)
  const matrix = encodeQr(result.payload)
  if (options.quiet !== true) {
    process.stdout.write(`${renderTerminal(matrix, 2)}\n\n`)
  }
  const lines = [
    `手机扫码即可配对（${String(minutes)} 分钟内有效）`,
    '',
    '  地址（App 会自己挑一个通的）：',
    ...result.hosts.map((host, index) => `    ${index === 0 ? '·' : '·'} ${host}:${String(result.port)}`),
    '',
    `  配对码：${result.code}`,
    '',
    '不想扫码的话，在 App 里手动填上面任一地址 + 这个码。',
    '配过一次之后 token 存在本机，**dsh 重启也不用重配**。',
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
  if (options.png !== undefined) {
    const png = options.png
    writeFileSync(png, renderPng(matrix))
    process.stdout.write(`\n二维码已存到 ${png}\n`)
  }
}

/** 供测试用：把二维码载荷解回结构。 */
/**
 * 解出配对载荷。两种格式都认：
 *  - 紧凑格式（当前）：`hosts|port|code|fp|name`
 *  - base64(JSON)（旧版）：手里的旧二维码还没过期时照样能用
 *
 * 判断依据是**能不能按紧凑格式解析出合法的端口和配对码**，而不是靠前缀
 * 版本号——旧码没有版本号，靠"像不像 JSON"来分更容易写错。
 */
export function decodePayload(payload: string): {
  v: number
  name: string
  hosts: string[]
  port: number
  code: string
  fp: string
} {
  const text = payload.startsWith('dshell-pair://') ? payload.slice('dshell-pair://'.length) : payload

  const compact = decodeCompact(text)
  if (compact) return compact

  // 旧格式：base64(JSON)
  try {
    const parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as {
      v?: unknown
      name?: unknown
      hosts?: unknown
      port?: unknown
      code?: unknown
      fp?: unknown
    }
    return {
      v: typeof parsed.v === 'number' ? parsed.v : 0,
      name: typeof parsed.name === 'string' ? parsed.name : '',
      hosts: Array.isArray(parsed.hosts) ? (parsed.hosts as string[]) : [],
      port: typeof parsed.port === 'number' ? parsed.port : 0,
      code: typeof parsed.code === 'string' ? parsed.code : '',
      fp: typeof parsed.fp === 'string' ? parsed.fp : '',
    }
  } catch {
    return { v: 0, name: '', hosts: [], port: 0, code: '', fp: '' }
  }
}

/** 试解紧凑格式；不像的话返回 null，交给旧格式兜底。 */
function decodeCompact(text: string): {
  v: number
  name: string
  hosts: string[]
  port: number
  code: string
  fp: string
} | null {
  // base64 里不会出现 `|`，所以有竖线就一定是紧凑格式
  if (!text.includes('|')) return null
  const [hostsPart = '', portPart = '', code = '', fp = '', name = ''] = text.split('|')
  const port = Number.parseInt(portPart, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  if (code.length === 0) return null
  const hosts = hostsPart.split(',').map((h) => h.trim()).filter((h) => h.length > 0)
  if (hosts.length === 0) return null
  return { v: 2, name, hosts, port, code, fp }
}
