import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ProviderEditError,
  encodeScalar,
  readProviders,
  setProviderField,
  clearProviderField,
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
