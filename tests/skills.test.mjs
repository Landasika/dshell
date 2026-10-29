import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  parseFrontmatter,
  readSkillFile,
  resolveHubDirs,
  scanSkillDirs,
  toSkillEntry,
} from '../dist/plugin/skills.js'

test('frontmatter splits data from the body and keeps block scalars', () => {
  const parsed = parseFrontmatter('---\nname: demo\ndescription: >-\n  a folded\n  description\n---\n# Body\n')
  assert.ok(parsed !== undefined)
  assert.equal(parsed.data.name, 'demo')
  assert.equal(parsed.data.description, 'a folded description')
  assert.equal(parsed.body, '# Body')
  assert.equal(parseFrontmatter('# no frontmatter'), undefined)
})

test('readSkillFile validates the name and description', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshell-hub-'))
  const dir = join(root, 'release-checklist')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), '---\nname: release-checklist\ndescription: "Ship it"\nwhenToUse: Before a tag\n---\n# Steps\n')
  const skill = readSkillFile(join(dir, 'SKILL.md'))
  assert.ok(skill !== undefined)
  assert.equal(skill.name, 'release-checklist')
  assert.equal(skill.description, 'Ship it')
  assert.equal(skill.whenToUse, 'Before a tag')
  assert.equal(skill.content, '# Steps')
  assert.equal(skill.modelInvocable, true)
  assert.equal(skill.userInvocable, true)

  await writeFile(join(dir, 'SKILL.md'), '---\nname: Bad Name\ndescription: nope\n---\nbody\n')
  assert.equal(readSkillFile(join(dir, 'SKILL.md')), undefined)
  await writeFile(join(dir, 'SKILL.md'), '---\nname: missing-description\n---\nbody\n')
  assert.equal(readSkillFile(join(dir, 'SKILL.md')), undefined)
})

test('frontmatter can opt out of model or user invocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshell-hub-'))
  const file = join(root, 'quiet.md')
  await writeFile(file, '---\nname: quiet\ndescription: hidden from the model\ndisable-model-invocation: true\nuser-invocable: false\n---\nbody\n')
  const skill = readSkillFile(file)
  assert.ok(skill !== undefined)
  assert.equal(skill.modelInvocable, false)
  assert.equal(skill.userInvocable, false)
  const entry = toSkillEntry({
    name: skill.name,
    description: skill.description,
    source: 'dshell-hub',
    provider: 'dshell-hub',
    invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
  })
  assert.equal(entry.modelInvocable, false)
  assert.equal(entry.userInvocable, false)
})

test('scanSkillDirs accepts bundles and flat files, first root wins', async () => {
  const first = await mkdtemp(join(tmpdir(), 'dshell-hub-a-'))
  const second = await mkdtemp(join(tmpdir(), 'dshell-hub-b-'))
  await mkdir(join(first, 'bundled'), { recursive: true })
  await writeFile(join(first, 'bundled', 'SKILL.md'), '---\nname: shared\ndescription: from the first root\n---\nA\n')
  await writeFile(join(second, 'shared.md'), '---\nname: shared\ndescription: from the second root\n---\nB\n')
  await writeFile(join(second, 'flat.md'), '---\nname: flat\ndescription: a flat skill\n---\nC\n')
  await writeFile(join(second, 'ignored.txt'), 'not a skill')
  await writeFile(join(second, 'no-frontmatter.md'), '# just a note\n')

  const skills = scanSkillDirs([first, second])
  assert.deepEqual(skills.map((skill) => skill.name), ['flat', 'shared'])
  assert.equal(skills.find((skill) => skill.name === 'shared').description, 'from the first root')
})

test('resolveHubDirs prefers config, then env, then the default shelf', () => {
  assert.deepEqual(resolveHubDirs({ configured: ['/a', '/b'], dshHome: '/home/u/.dsh' }), ['/a', '/b'])
  assert.deepEqual(resolveHubDirs({ configured: '/a:/b', dshHome: '/home/u/.dsh' }), ['/a', '/b'])
  assert.deepEqual(resolveHubDirs({ env: '/env/skills', dshHome: '/home/u/.dsh' }), ['/env/skills'])
  assert.deepEqual(resolveHubDirs({ dshHome: '/home/u/.dsh' }), ['/home/u/.dsh/dshell-skills'])
})
