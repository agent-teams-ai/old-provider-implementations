import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDriverNative } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-driver-native.ts'
import { ExecutionTransportFailure } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-failures.ts'
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

test('stock CLI sync-only log is not a durable execution preflight and cannot submit a model prompt', async t => {
  const host = await driverPeer(); t.after(host.close); host.syncOnlyLog()
  const native = createDriverNative(nativeConfig(host), new AbortController().signal)
  await assert.rejects(native.queue('msg_TESTnotSent', 'TEST must not execute'), error => {
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
    return true
  })
  assert.deepEqual(host.counts(), { submitted: 0, interrupted: 0, replies: 0 })
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

test('native queue preserves UNKNOWN when preflight response stream cancellation fails, without prompt POST', async t => {
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await driverPeer(); t.after(host.close)
    const config = nativeConfig(host); config.version = version
    let reads = 0, cancellations = 0
    config.fetchImpl = async (input, init) => {
      assert.equal(new Request(input, init).method, 'GET')
      reads++
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)) },
        cancel() { cancellations++; throw new Error('TEST-private-native-path') },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const native = createDriverNative(config, new AbortController().signal)
    await assert.rejects(native.queue('msg_TESTpreflight', 'TEST must not submit'), error => {
      assert.ok(error instanceof ExecutionTransportFailure)
      assert.equal(error.code, 'cleanup_unknown')
      assert.equal(error.disposition, 'unknown')
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
      assert.equal(String(error).includes('TEST-private-native-path'), false)
      return true
    })
    assert.equal(reads, 1)
    assert.equal(cancellations, 1)
    assert.equal(host.counts().submitted, 0)
  }
})

test('legacy flat V1-like read never submits, and malformed post-ACK is unknown without replay', async t => {
  const legacy = await driverPeer(); t.after(legacy.close); legacy.flatSession()
  const blocked = createDriverNative(nativeConfig(legacy), new AbortController().signal)
  await assert.rejects(blocked.queue('msg_TESTfirst', 'TEST read'), error => {
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
  })
  assert.equal(legacy.counts().submitted, 0)

  const wrongAck = await driverPeer(); t.after(wrongAck.close); wrongAck.flatPrompt()
  const uncertain = createDriverNative(nativeConfig(wrongAck), new AbortController().signal)
  await assert.rejects(uncertain.queue('msg_TESTfirst', 'TEST once'), error => {
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), false); return true
  })
  assert.equal(wrongAck.counts().submitted, 1)
})
