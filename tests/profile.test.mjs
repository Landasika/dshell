import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ProviderEditError,
  addProvider,
  clearProviderField,
  encodeScalar,
  readProviders,
  removeProvider,
  setProviderField,
} from '../dist/plugin/profile.js'

const PATCH = `# home patch
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      kimi-relay:
        apiKeyEnv: KIMI_RELAY_API_KEY
        displayName: Kimi 中转站
        api: anthropic-messages
        baseURL: http://192.168.8.77:8180
        models:
          - id: kimi-latest
            input: []
          - id: k3
            contextWindow: 1048576
        defaultMaxTokens: 32768
      glm-sa:
        apiKeyEnv: GLM_SA_API_KEY
        baseURL: http://192.168.8.77:8180
        models:
          - id: glm-5.3
- id: other-plugin
  config: {}
`

test('readProviders reads ids, scalar fields and model counts', () => {
  const providers = readProviders(PATCH)
  assert.deepEqual(providers, [
    {
      id: 'kimi-relay',
      apiKeyEnv: 'KIMI_RELAY_API_KEY',
      displayName: 'Kimi 中转站',
      baseURL: 'http://192.168.8.77:8180',
      models: 2,
    },
    {
      id: 'glm-sa',
      apiKeyEnv: 'GLM_SA_API_KEY',
      baseURL: 'http://192.168.8.77:8180',
      models: 1,
    },
  ])
  assert.deepEqual(readProviders('- id: llm-pi-ai\n  config: {}\n'), [])
})

test('setProviderField rewrites one line and leaves everything else intact', () => {
  const next = setProviderField(PATCH, 'glm-sa', 'baseURL', 'https://glm.example/v1')
  assert.equal(next, PATCH.replace(
    '      glm-sa:\n        apiKeyEnv: GLM_SA_API_KEY\n        baseURL: http://192.168.8.77:8180',
    '      glm-sa:\n        apiKeyEnv: GLM_SA_API_KEY\n        baseURL: https://glm.example/v1',
  ))
  assert.equal(readProviders(next)[1].baseURL, 'https://glm.example/v1')
  // Other providers are untouched.
  assert.equal(readProviders(next)[0].displayName, 'Kimi 中转站')
})

test('setProviderField inserts a missing key under the provider id', () => {
  const next = setProviderField(PATCH, 'glm-sa', 'displayName', 'GLM 直连')
  assert.equal(readProviders(next)[1].displayName, 'GLM 直连')
  assert.match(next, /      glm-sa:\n {8}displayName: 'GLM 直连'\n {8}apiKeyEnv: GLM_SA_API_KEY/)
})

test('setProviderField quotes values a plain scalar would misread', () => {
  assert.equal(encodeScalar('http://192.168.8.77:8180'), 'http://192.168.8.77:8180')
  assert.equal(encodeScalar('KIMI_RELAY_API_KEY'), 'KIMI_RELAY_API_KEY')
  assert.equal(encodeScalar('Kimi 中转站'), "'Kimi 中转站'")
  assert.equal(encodeScalar('true'), "'true'")
  assert.equal(encodeScalar('8080'), "'8080'")
  assert.equal(encodeScalar("it's #1"), "'it''s #1'")
  const next = setProviderField(PATCH, 'kimi-relay', 'displayName', 'Kimi: relay #2')
  assert.equal(readProviders(next)[0].displayName, 'Kimi: relay #2')
})

test('setProviderField refuses patches it cannot place', () => {
  assert.throws(
    () => setProviderField('- id: x\n  config: {}\n', 'glm-sa', 'baseURL', 'https://a'),
    (error) => error instanceof ProviderEditError && error.code === 'PROVIDERS_NOT_FOUND',
  )
  assert.throws(
    () => setProviderField(PATCH, 'missing', 'baseURL', 'https://a'),
    (error) => error instanceof ProviderEditError && error.code === 'PROVIDER_NOT_FOUND',
  )
})

test('clearProviderField removes only the requested scalar', () => {
  const next = clearProviderField(PATCH, 'kimi-relay', 'displayName')
  assert.equal(readProviders(next)[0].displayName, undefined)
  assert.equal(readProviders(next)[0].models, 2)
  assert.equal(next.split('\n').length, PATCH.split('\n').length - 1)
})

test('addProvider appends a well-formed block with models', () => {
  const next = addProvider(PATCH, {
    id: 'my-relay',
    baseURL: 'https://relay.example/v1',
    apiKeyEnv: 'MY_RELAY_API_KEY',
    displayName: 'My Relay',
    models: ['m1', 'm2'],
  })
  const providers = readProviders(next)
  assert.deepEqual(providers.map((provider) => provider.id), ['kimi-relay', 'glm-sa', 'my-relay'])
  assert.deepEqual(providers[2], {
    id: 'my-relay',
    apiKeyEnv: 'MY_RELAY_API_KEY',
    displayName: 'My Relay',
    baseURL: 'https://relay.example/v1',
    models: 2,
  })
  // The inserted block sits inside the providers map, above the next entry.
  assert.match(next, /      my-relay:\n {8}apiKeyEnv: MY_RELAY_API_KEY\n {8}displayName: 'My Relay'\n {8}baseURL: https:\/\/relay\.example\/v1\n {8}models:\n {10}- id: m1\n {10}- id: m2\n- id: other-plugin/)
  // Existing providers are untouched byte for byte.
  assert.equal(next.slice(0, next.indexOf('      my-relay:')), PATCH.slice(0, PATCH.indexOf('- id: other-plugin')))
})

test('addProvider refuses unsafe ids, duplicates and empty model lists', () => {
  assert.throws(
    () => addProvider(PATCH, { id: 'bad id', baseURL: 'https://a', models: ['m'] }),
    (error) => error instanceof ProviderEditError && error.code === 'BAD_FIELD',
  )
  assert.throws(
    () => addProvider(PATCH, { id: 'glm-sa', baseURL: 'https://a', models: ['m'] }),
    (error) => error instanceof ProviderEditError && error.code === 'PROVIDER_EXISTS',
  )
  assert.throws(
    () => addProvider(PATCH, { id: 'new', baseURL: 'https://a', models: [] }),
    (error) => error instanceof ProviderEditError && error.code === 'BAD_FIELD',
  )
})

test('removeProvider deletes exactly one block', () => {
  const next = removeProvider(PATCH, 'kimi-relay')
  assert.deepEqual(readProviders(next).map((provider) => provider.id), ['glm-sa'])
  assert.equal(next.includes('KIMI_RELAY_API_KEY'), false)
  assert.equal(next.includes('- id: other-plugin'), true)
  assert.equal(next.includes('glm-5.3'), true)
})

test('removeProvider keeps the last provider and unknown ids', () => {
  const single = '- id: llm-pi-ai\n  config:\n    providers:\n      only:\n        baseURL: https://a\n        models:\n          - id: m\n'
  assert.throws(
    () => removeProvider(single, 'only'),
    (error) => error instanceof ProviderEditError && error.code === 'EMPTY_PROVIDERS',
  )
  assert.throws(
    () => removeProvider(PATCH, 'nope'),
    (error) => error instanceof ProviderEditError && error.code === 'PROVIDER_NOT_FOUND',
  )
})

test('edits preserve a trailing newline and its absence', () => {
  const withNewline = addProvider(PATCH, { id: 'n1', baseURL: 'https://a', models: ['m'] })
  assert.equal(withNewline.endsWith('\n'), true)
  assert.equal(removeProvider(withNewline, 'n1'), PATCH)
  const withoutNewline = PATCH.slice(0, -1)
  const added = addProvider(withoutNewline, { id: 'n2', baseURL: 'https://a', models: ['m'] })
  assert.equal(added.endsWith('\n'), false)
  assert.equal(removeProvider(added, 'n2'), withoutNewline)
  assert.equal(setProviderField(withoutNewline, 'glm-sa', 'baseURL', 'https://b').endsWith('\n'), false)
  assert.equal(clearProviderField(PATCH, 'glm-sa', 'apiKeyEnv').endsWith('\n'), true)
})
