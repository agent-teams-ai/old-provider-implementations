import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isCanonicalOpenCodeV2LoopbackEndpoint } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-loopback-endpoint.ts'

test('all V2 transports share exact string-only loopback authority admission', () => {
  for (const port of [1, 14321, 65535]) {
    assert.equal(isCanonicalOpenCodeV2LoopbackEndpoint(`http://127.0.0.1:${port}`), true)
  }
  for (const value of [
    null, undefined, false, 14321,
    ['http://127.0.0.1:14321'],
    { toString: () => 'http://127.0.0.1:14321' },
    'http://127.0.0.1:0', 'http://127.0.0.1:00001',
    'http://127.0.0.1:65536', 'http://127.0.0.1:99999',
    'http://127.0.0.1:1234567890', 'http://localhost:14321',
    'http://127.0.0.2:14321', 'https://127.0.0.1:14321',
    'http://127.0.0.1:14321/', 'http://127.0.0.1:14321/path',
    'http://127.0.0.1:14321?x=1', 'http://127.0.0.1:14321#hash',
  ]) assert.equal(isCanonicalOpenCodeV2LoopbackEndpoint(value), false, String(value))
})
