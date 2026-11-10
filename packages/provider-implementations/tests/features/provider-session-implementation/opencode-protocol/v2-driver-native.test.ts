import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDriverNative } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-driver-native.ts'
import { wasOpenCodeV2InputNotSubmitted, projectOpenCodeV2NativeTurn } from '../../../../src/opencode.ts'
import { nativeConfig } from './v2-driver-support.ts'
import { driverPeer } from './v2-driver-peer.ts'


test('fresh finite native operations retain original queue anchor and qualify its actual HTTP cut', async t => {
  const host = await driverPeer(); t.after(host.close)
  const native = createDriverNative(nativeConfig(host), new AbortController().signal)
  const original = await native.queue('msg_TESTfirst', 'TEST first message')
  assert.deepEqual(original, { nativeInputID: 'msg_TESTfirst', text: 'TEST first message', beforeCursor: 0 })
  const value = await native.read(original)
  assert.equal(projectOpenCodeV2NativeTurn(value).state, 'succeeded')
  assert.deepEqual(host.counts(), { submitted: 1, interrupted: 0, replies: 0 })
})

test('native queue preflight rejects foreign workspace before POST while lost mutation receipt is unknown', async t => {
  for (const mode of ['foreign', 'lost'] as const) {
    const host = await driverPeer(); t.after(host.close)
    if (mode === 'foreign') {host.foreign();} else {host.loseReceipt()}
    const native = createDriverNative(nativeConfig(host), new AbortController().signal)
    await assert.rejects(native.queue('msg_TESTfirst', 'TEST first message'), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), mode === 'foreign'); return true
    })
    assert.equal(host.counts().submitted, mode === 'foreign' ? 0 : 1)
  }
})
