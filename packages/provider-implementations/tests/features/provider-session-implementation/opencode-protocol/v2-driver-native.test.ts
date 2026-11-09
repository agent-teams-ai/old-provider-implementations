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


test('unknown native stream cleanup stays unknown across driver disposal for queue, read and control', async t => {
  for (const version of ['2.0.0', '2.0.21'] as const) {
    for (const operation of ['queue', 'read', 'control'] as const) {
      const host = await driverPeer(); t.after(host.close)
      const config = nativeConfig(host); config.version = version
      let reads = 0, cancellations = 0
      config.fetchImpl = async () => {
        reads++
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)) },
          cancel() { cancellations++; throw new Error('TEST-private-stream-should-not-leak') },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const native = createDriverNative(config, new AbortController().signal)
      const work = operation === 'queue' ? native.queue('msg_TESTcleanup', 'TEST once')
        : operation === 'read' ? native.read({ nativeInputID: 'msg_TESTcleanup', text: 'TEST once', beforeCursor: 0 })
          : native.control(wire => wire.instructions())
      await assert.rejects(work, error => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, operation === 'read' ? 'native_read_cleanup_unknown' : 'cleanup_unknown')
        assert.equal(String(error).includes('TEST-private-stream-should-not-leak'), false)
        return true
      })
      assert.equal(reads, 1)
      assert.equal(cancellations, 1)
      assert.equal(host.counts().submitted, 0)
      await assert.rejects(native.dispose(), /cleanup_unknown/)
      // Cleanup UNKNOWN revokes this driver instance; a subsequent operation
      // must not regain credentials or perform a new native request.
      for (const retry of [
        () => native.queue('msg_TESTnext', 'TEST must not replay'),
        () => native.read({ nativeInputID: 'msg_TESTnext', text: 'TEST must not replay', beforeCursor: 0 }),
        () => native.control(wire => wire.instructions()),
      ]) {
        await assert.rejects(retry(), error => {
          assert.ok(error instanceof ExecutionTransportFailure)
          assert.equal(error.code, 'cleanup_unknown')
          assert.equal(error.disposition, 'unknown')
          return true
        })
      }
      assert.equal(reads, 1)
      assert.equal(host.counts().submitted, 0)
    }
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
  // The first POST may have executed. Never submit a second prompt through
  // the same driver until a new authoritative generation reconciles it.
  await assert.rejects(uncertain.queue('msg_TESTsecond', 'TEST must not replay'), error => {
    assert.ok(error instanceof ExecutionTransportFailure)
    assert.equal(error.code, 'native_prompt_unknown')
    assert.equal(error.disposition, 'unknown')
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
    return true
  })
  assert.equal(wrongAck.counts().submitted, 1)
})

test('unconfirmed native prompt fences all control mutations, including delayed callbacks, while read-only reconciliation works', async t => {
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await driverPeer(); t.after(host.close); host.loseReceipt()
    const config = nativeConfig(host); config.version = version
    let nativeRequests = 0
    config.fetchImpl = async (input, init) => {
      nativeRequests++
      return fetch(input, init)
    }
    const native = createDriverNative(config, new AbortController().signal)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    // The control callback was admitted before the prompt became UNKNOWN.
    // Its delayed mutation must still be rejected after the failed POST.
    const delayed = native.control(async wire => { await gate; return wire.interrupt() })
    try {
      await assert.rejects(native.queue('msg_TESTunknown', 'TEST once'), error => {
        assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
        return true
      })
      assert.equal(host.counts().submitted, 1)
      const afterUnknown = nativeRequests
      release()
      const mutations = [
        delayed,
        native.control(wire => wire.interrupt()),
        native.control(wire => wire.cancelInbox('msg_TESTunknown')),
        native.control(wire => wire.replyPermission('per_TESTpermission', 'reject')),
        native.control(wire => wire.putInstruction('test-context', { value: 'TEST' })),
      ]
      for (const mutation of mutations) {
        await assert.rejects(mutation, error => {
          assert.ok(error instanceof ExecutionTransportFailure)
          assert.equal(error.code, 'native_prompt_unknown')
          assert.equal(error.disposition, 'unknown')
          assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
          return true
        })
      }
      assert.equal(nativeRequests, afterUnknown)
      assert.deepEqual(host.counts(), { submitted: 1, interrupted: 0, replies: 0 })
      assert.deepEqual(host.cancelled, [])
      assert.deepEqual(await native.control(wire => wire.pendingPermissions()), [])
      assert.equal(nativeRequests, afterUnknown + 1)
    } finally { release(); await native.dispose() }
  }
})

test('permission detail already in flight cannot POST a grant after concurrent native prompt becomes unknown', async t => {
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await driverPeer(); t.after(host.close); host.loseReceipt(); host.pauseReplyPreflight()
    const config = nativeConfig(host); config.version = version
    const native = createDriverNative(config, new AbortController().signal)
    const grant = native.control(wire => wire.replyPermission('per_TESTpermission', 'reject'))
    try {
      const timeout = Date.now() + 1500
      while (host.permissionDetails() !== 1) {
        assert.ok(Date.now() < timeout, 'TEST detail preflight not entered')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      await assert.rejects(native.queue('msg_TESTunknown', 'TEST once'), error => {
        assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
        return true
      })
      host.releaseReplyPreflight()
      await assert.rejects(grant, error => {
        assert.ok(error instanceof ExecutionTransportFailure)
        assert.equal(error.code, 'native_prompt_unknown')
        return true
      })
      assert.equal(host.counts().submitted, 1)
      assert.equal(host.counts().replies, 0)
    } finally {
      host.releaseReplyPreflight()
      await native.dispose()
    }
  }
})
