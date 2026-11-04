/**
 * `dshell install` 的测试。
 *
 * 这个命令会改用户的 profile 目录——里面放着 API key、模型配置、私有
 * baseURL。所以测试的重点不是"能不能装上"，而是**不破坏已有内容**：
 * 追加而不是重写、重复执行不重复追加、非法输入时宁可什么都不做。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { addBundle, appendWsConfig, serviceUnit } from '../dist/cli/install.js'

test('appendWsConfig：空数组模板被替换，而不是追加成非法 YAML', () => {
  // dsh 的默认模板就是 `[]`；直接追加会得到 `[]` + block sequence，非法
  const template = '# comment\n[]\n'
  const result = appendWsConfig(template, 8792)
  assert.ok(result !== undefined)
  assert.ok(!/^\s*\[\]\s*$/m.test(result), '不该残留空数组')
  assert.match(result, /- id: dshell-host/)
  assert.match(result, /wsPort: 8792/)
  assert.match(result, /# comment/, '原有注释要保留')
})

test('appendWsConfig：已有条目时返回 undefined（幂等）', () => {
  const existing = "- id: dshell-host\n  config:\n    wsPort: 8792\n"
  assert.equal(appendWsConfig(existing, 8792), undefined)
})

test('appendWsConfig：追加到已有配置末尾，不动前面内容', () => {
  const existing = "- id: llm-pi-ai\n  config:\n    providers: {}\n"
  const result = appendWsConfig(existing, 8792)
  assert.ok(result !== undefined)
  assert.ok(result.startsWith(existing), '原有内容必须原样在前面')
  assert.match(result, /- id: dshell-host/)
})

test('appendWsConfig：自定义端口写进去', () => {
  const result = appendWsConfig('[]\n', 9999)
  assert.match(result, /wsPort: 9999/)
})

test('addBundle：加入 bundles 与 dependencies 各一次', () => {
  const before = JSON.stringify({
    name: 'p',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  })
  const result = addBundle(before)
  assert.ok(result !== undefined)
  const parsed = JSON.parse(result)
  assert.deepEqual(parsed.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@landasika/dshell'])
  assert.equal(parsed.dependencies['@landasika/dshell'], 'latest')
})

test('addBundle：已存在时返回 undefined（幂等）', () => {
  const before = JSON.stringify({
    name: 'p',
    dependencies: { '@landasika/dshell': 'latest' },
    dsh: { profile: { bundles: ['@landasika/dshell'] } },
  })
  assert.equal(addBundle(before), undefined)
})

test('addBundle：保留其它字段', () => {
  const before = JSON.stringify({
    name: 'p',
    private: true,
    scripts: { build: 'tsc' },
    dependencies: { yaml: '^2' },
    dsh: { profile: { bundles: [] }, other: { keep: true } },
  })
  const parsed = JSON.parse(addBundle(before))
  assert.equal(parsed.scripts.build, 'tsc', 'scripts 要保留')
  assert.equal(parsed.dependencies.yaml, '^2', '其它依赖要保留')
  assert.deepEqual(parsed.dsh.other, { keep: true }, 'dsh 下的其它字段要保留')
})

test('addBundle：非法 JSON 时拒绝修改，而不是写出坏文件', () => {
  assert.throws(() => addBundle('{ not json'), /不是合法 JSON/)
})

test('serviceUnit：ExecStart 用绝对路径，重启策略存在', () => {
  const unit = serviceUnit('dshell', '/usr/bin/node', '/usr/lib/node_modules/dsh/bin.js')
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/usr\/lib\/node_modules\/dsh\/bin\.js --profile dshell/)
  assert.match(unit, /Restart=on-failure/)
  assert.match(unit, /WantedBy=default\.target/)
  assert.match(unit, /EnvironmentFile=-%h\/\.dsh\/dsh-host\.env/, '要支持注入环境变量')
})

test('端到端：在干净目录上安装出可用的 profile', async () => {
  const { runInstall } = await import('../dist/cli/install.js')
  const home = mkdtempSync(join(tmpdir(), 'dshell-install-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // 预置一个"用户已配好模型"的 profile
    const dir = join(home, 'profiles', 'dshell')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-dshell',
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }))
    const userConfig = "- id: llm-pi-ai\n  config:\n    baseURL: http://example\n"
    writeFileSync(join(dir, 'cordis.patch.yml'), userConfig)

    const result = await runInstall({ profile: 'dshell', noService: true })
    assert.equal(result.profile, 'dshell')

    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    assert.ok(patch.startsWith(userConfig), '用户配置必须原样保留')
    assert.match(patch, /- id: dshell-host/)
    assert.match(patch, /wsPort: 8792/)

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    assert.ok(pkg.dsh.profile.bundles.includes('@landasika/dshell'))

    // 第二次执行应全部 unchanged，且不产生重复条目
    const again = await runInstall({ profile: 'dshell', noService: true })
    assert.ok(again.steps.every((s) => s.action === 'unchanged'), '重复执行应无变化')
    const patch2 = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    assert.equal(patch2, patch, '重复执行不该改动文件')
    assert.equal((patch2.match(/- id: dshell-host/g) ?? []).length, 1, '不该重复追加')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('dry-run 不写任何文件', async () => {
  const { runInstall } = await import('../dist/cli/install.js')
  const home = mkdtempSync(join(tmpdir(), 'dshell-dry-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const dir = join(home, 'profiles', 'dshell')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } },
    }))
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
    const result = await runInstall({ profile: 'dshell', noService: true, dryRun: true })
    assert.ok(result.steps.some((s) => s.action === 'updated'), '应报告将要更新')
    // 文件实际未变
    assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), '[]\n')
    assert.ok(!existsSync(join(dir, 'cordis.patch.yml.bak-1')), 'dry-run 不该产生备份')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
