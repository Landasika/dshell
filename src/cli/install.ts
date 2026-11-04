/**
 * `dshell install`：把 dshell 装进一个 dsh profile，并把常驻服务建好。
 *
 * ## 为什么需要它
 *
 * 在这之前，装 dshell 是四步手工活：建 profile 目录、写 package.json 的
 * bundles、写 cordis.patch.yml 的 wsPort、写 systemd 单元。每一步都容易漏，
 * 而漏了的症状是"手机连不上"——离原因很远。换一台机器就得再走一遍。
 *
 * ## 最重要的约束：不覆盖已有配置
 *
 * profile 里放的是用户的模型配置、API key 环境变量名、私有 baseURL。
 * 装 dshell 绝不能碰这些。所以这里的规则是：
 *
 * - 文件不存在 → 创建
 * - 文件存在但缺必要配置 → **只追加缺的那部分**，其余原样保留
 * - 文件存在且已配好 → 什么都不做，报告"已就绪"
 *
 * 任何时候用户已有的内容都不会被重写。想改就得自己改，或者显式删掉重来。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { resolveDshHome } from '../shared/paths.js'

/** 装进 profile 的插件包名。 */
const PLUGIN = '@landasika/dshell'
/** 手机连进来用的默认端口。 */
const DEFAULT_WS_PORT = 8792

export interface InstallOptions {
  /** profile 名，默认 `dshell`。 */
  profile?: string
  /** WebSocket 端口，默认 8792。 */
  port?: number
  /** 跳过 profile 安装，只建服务。 */
  serviceOnly?: boolean
  /** 只建 profile，不碰 systemd。 */
  noService?: boolean
  /** 是否真的写文件；false 时只报告将要做什么。 */
  dryRun?: boolean
}

export interface InstallStep {
  /** 做了什么：`created` / `updated` / `unchanged` / `skipped`。 */
  action: 'created' | 'updated' | 'unchanged' | 'skipped'
  /** 操作对象，给人看的路径或描述。 */
  target: string
  /** 补充说明。 */
  detail?: string
}

export interface InstallResult {
  profile: string
  profileDir: string
  steps: InstallStep[]
  /** 需要用户手动做的事。 */
  nextSteps: string[]
}

/** profile 目录路径。 */
export function profileDir(profile: string): string {
  return join(resolveDshHome(), 'profiles', profile)
}

/**
 * 读一个 YAML 文件里的条目列表。
 *
 * 这里不引 yaml 解析器：只需要知道"文件里有没有 dshell-host 这个 id"，
 * 用文本判断就够，也避免因为用户文件里有特殊结构而解析失败。
 */
function hasEntry(text: string, id: string): boolean {
  return new RegExp(`^\\s*-?\\s*id:\\s*['"]?${id}['"]?\\s*$`, 'm').test(text) ||
    new RegExp(`id:\\s*['"]?${id}['"]?`).test(text)
}

/**
 * 把 wsPort 配置追加到 cordis.patch.yml。
 *
 * 返回追加后的全文；已经配过则返回 undefined。
 */
export function appendWsConfig(text: string, port: number): string | undefined {
  if (hasEntry(text, 'dshell-host')) return undefined
  const block = [
    '# 手机与宠物直连：WebSocket 入口，与 CLI 共用同一个中枢。',
    '# 由 `dshell install` 追加；已有内容不会被改动。',
    '- id: dshell-host',
    '  config:',
    `    wsPort: ${String(port)}`,
    '    wsHost: 0.0.0.0',
  ].join('\n')

  /**
   * 模板里的 patch 层初始内容是 `[]`（一个空数组）。
   *
   * 直接往后追加会得到 `[]` 加一个 block sequence，那是**非法 YAML**——
   * 全新安装会当场坏掉，而且报错指向第 8 行，看起来莫名其妙。
   * 所以遇到空数组时把它替换掉，而不是追加。
   */
  const emptyArray = /^\s*\[\]\s*$/m
  if (emptyArray.test(text) && !/^\s*-/m.test(text)) {
    return `${text.replace(emptyArray, `${block}\n`).replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
  }
  return `${text.replace(/\n*$/, '\n')}${block}\n`
}

/**
 * 把插件加进 package.json 的 bundles。
 *
 * 返回新内容；已经在了则返回 undefined。
 */
export function addBundle(text: string, plugin = PLUGIN): string | undefined {
  let parsed: { dsh?: { profile?: { bundles?: unknown } }; dependencies?: Record<string, string> }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    throw new Error('package.json 不是合法 JSON，为避免损坏你的配置，install 不会修改它')
  }
  const bundles = parsed.dsh?.profile?.bundles
  const list = Array.isArray(bundles) ? (bundles as string[]) : []
  if (list.includes(plugin)) return undefined
  list.push(plugin)
  parsed.dsh = parsed.dsh ?? {}
  parsed.dsh.profile = parsed.dsh.profile ?? {}
  parsed.dsh.profile.bundles = list
  // 依赖也要写：否则 pnpm install 不会装它
  parsed.dependencies = parsed.dependencies ?? {}
  if (parsed.dependencies[plugin] === undefined) parsed.dependencies[plugin] = 'latest'
  return `${JSON.stringify(parsed, null, 2)}\n`
}

/** 生成 systemd user 单元内容。 */
export function serviceUnit(profile: string, nodePath: string, dshBin: string): string {
  return `# DSH Host 常驻（${profile} profile）。由 \`dshell install\` 生成。
#
# 需要给插件传环境变量（如 API key）时，写进 ~/.dsh/dsh-host.env，
# 这个文件里的内容会作为环境变量传进进程。
[Unit]
Description=DSH Host (${profile} profile)
After=network.target

[Service]
EnvironmentFile=-%h/.dsh/dsh-host.env
ExecStart=${nodePath} ${dshBin} --profile ${profile}
WorkingDirectory=%h
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`
}

/** 跑一个命令，返回 stdout；失败时返回 undefined（不抛）。 */
function tryExec(file: string, args: string[]): string | undefined {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

/**
 * 找 dsh 的入口脚本。
 *
 * 用 `which dsh` 的软链目标而不是写死路径：nvm、系统 node、不同 Node 版本
 * 下路径都不一样，写死必然在换机器时失效。
 */
export function findDshBin(): { node: string; dsh: string } | undefined {
  const which = tryExec('which', ['dsh'])
  if (which === undefined || which.length === 0) return undefined
  // 软链解析成真实文件
  const real = tryExec('readlink', ['-f', which]) ?? which
  const node = tryExec('which', ['node'])
  if (node === undefined) return undefined
  return { node, dsh: real }
}

/** 主流程。 */
export async function runInstall(options: InstallOptions = {}): Promise<InstallResult> {
  const profile = options.profile ?? 'dshell'
  const port = options.port ?? DEFAULT_WS_PORT
  const steps: InstallStep[] = []
  const nextSteps: string[] = []
  const dir = profileDir(profile)
  const dryRun = options.dryRun === true

  if (options.serviceOnly !== true) {
    if (!existsSync(dir)) {
      if (dryRun) {
        steps.push({ action: 'created', target: dir, detail: '将创建 profile 目录（含四个骨架文件）' })
      } else {
        // 借用 dsh 自己的模板创建，比手写骨架可靠（它知道该有哪些文件）
        mkdirSync(dirname(dir), { recursive: true })
        const made = tryExec('dsh', ['--from-default-profile', 'web', '--profile', profile, '--dump-config'])
        if (made === undefined && !existsSync(join(dir, 'package.json'))) {
          throw new Error(
            `创建 profile 失败：dsh 没能生成 ${dir}\n` +
            '请确认 dsh 已安装并且在 PATH 里（which dsh）。',
          )
        }
        steps.push({ action: 'created', target: dir, detail: 'profile 骨架（dsh 默认 web 模板）' })
      }
    } else {
      steps.push({ action: 'unchanged', target: dir, detail: 'profile 已存在，保留原样' })
    }

    // ---- package.json ----
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      const before = readFileSync(pkgPath, 'utf8')
      const after = addBundle(before)
      if (after === undefined) {
        steps.push({ action: 'unchanged', target: pkgPath, detail: `已包含 ${PLUGIN}` })
      } else if (dryRun) {
        steps.push({ action: 'updated', target: pkgPath, detail: `将加入 ${PLUGIN}` })
      } else {
        copyFileSync(pkgPath, `${pkgPath}.bak-${String(Date.now())}`)
        writeFileSync(pkgPath, after)
        steps.push({ action: 'updated', target: pkgPath, detail: `加入 ${PLUGIN}（原文件已备份）` })
      }
    } else if (!dryRun) {
      throw new Error(`${pkgPath} 不存在，profile 目录不完整`)
    }

    // ---- cordis.patch.yml ----
    const patchPath = join(dir, 'cordis.patch.yml')
    if (existsSync(patchPath)) {
      const before = readFileSync(patchPath, 'utf8')
      const after = appendWsConfig(before, port)
      if (after === undefined) {
        steps.push({ action: 'unchanged', target: patchPath, detail: `已配置 wsPort` })
      } else if (dryRun) {
        steps.push({ action: 'updated', target: patchPath, detail: `将追加 dshell-host / wsPort: ${String(port)}` })
      } else {
        copyFileSync(patchPath, `${patchPath}.bak-${String(Date.now())}`)
        writeFileSync(patchPath, after)
        steps.push({
          action: 'updated',
          target: patchPath,
          detail: `追加 dshell-host / wsPort: ${String(port)}（原有内容未改动，已备份）`,
        })
      }
    } else if (!dryRun) {
      writeFileSync(patchPath, appendWsConfig('', port) ?? '')
      steps.push({ action: 'created', target: patchPath })
    }

    nextSteps.push(`安装插件依赖：dsh plugin --profile ${profile} install`)
  }

  // ---- systemd ----
  if (options.noService !== true) {
    const unitDir = join(process.env.HOME ?? '', '.config', 'systemd', 'user')
    const unitPath = join(unitDir, 'dsh-host.service')
    const found = findDshBin()
    if (found === undefined) {
      steps.push({ action: 'skipped', target: unitPath, detail: '找不到 dsh 或 node，跳过服务' })
      nextSteps.push('装好 dsh 后重跑：dshell install --service-only')
    } else if (existsSync(unitPath)) {
      steps.push({ action: 'unchanged', target: unitPath, detail: '服务文件已存在，保留原样' })
      nextSteps.push(`重启生效：systemctl --user restart dsh-host.service`)
    } else if (dryRun) {
      steps.push({ action: 'created', target: unitPath, detail: '将创建 systemd 单元' })
    } else {
      mkdirSync(unitDir, { recursive: true })
      writeFileSync(unitPath, serviceUnit(profile, found.node, found.dsh))
      steps.push({ action: 'created', target: unitPath })
      tryExec('systemctl', ['--user', 'daemon-reload'])
      const linked = tryExec('systemctl', ['--user', 'enable', 'dsh-host.service'])
      steps.push({
        action: linked === undefined ? 'skipped' : 'created',
        target: 'systemctl --user enable dsh-host.service',
        detail: linked === undefined ? '启用失败，请手动执行' : '已设为开机自启',
      })
      nextSteps.push('启动 Host：systemctl --user start dsh-host.service')
    }
  }

  nextSteps.push('配对手机：dshell remote')
  return { profile, profileDir: dir, steps, nextSteps }
}

/** 把结果打印成人能读的报告。 */
export function printInstall(result: InstallResult, dryRun: boolean): void {
  const mark = (action: InstallStep['action']): string =>
    action === 'created' ? '+' : action === 'updated' ? '~' : action === 'unchanged' ? '=' : '-'
  const lines: string[] = []
  lines.push(`${dryRun ? '将要执行（--dry-run）' : '安装完成'}：profile "${result.profile}"`)
  lines.push('')
  for (const step of result.steps) {
    lines.push(`  ${mark(step.action)} ${step.target}`)
    if (step.detail !== undefined) lines.push(`      ${step.detail}`)
  }
  if (result.nextSteps.length > 0) {
    lines.push('')
    lines.push(dryRun ? '正式执行后还需要：' : '接下来：')
    for (const next of result.nextSteps) lines.push(`  · ${next}`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

/** 供测试：默认端口常量。 */
export const DEFAULT_PORT = DEFAULT_WS_PORT

/** 供测试：把路径转成绝对路径，方便断言。 */
export function absDir(profile: string): string {
  return resolve(profileDir(profile))
}
