import assert from 'node:assert/strict'
import { channel } from 'node:diagnostics_channel'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { Event } from '@agent-teams/provider-session-contracts'
import { createV2DriverSession } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-driver-session.ts'
import { OpenCodeDriverSession } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/driver-session.ts'
import type { DriverSessionConfig } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/driver-protocol.ts'
import { nativeConfig } from './v2-driver-support.ts'
import { driverPeer } from './v2-driver-peer.ts'

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000
  while (!predicate()) { if (Date.now() > deadline) {assert.fail('TEST observation deadline');} await delay(10) }
}

test('native session consumer serializes two actual HTTP inputs and preserves canonical attribution', async t => {
  const host = await driverPeer(); t.after(host.close)
  const session = createV2DriverSession(nativeConfig(host)), events: Event[] = []
  const observed = (async () => { for await (const event of session.observe()) {events.push(event)} })()
  try {
    const first = session.submit({ inputId: 'TEST-input1', operationRef: 'TEST-op1', content: 'TEST first' })
    const second = session.submit({ inputId: 'TEST-input2', operationRef: 'TEST-op2', content: 'TEST second' })
    assert.equal((await first).ok, true); assert.equal((await second).ok, true)
    await until(() => events.filter(event => event.kind === 'result').length === 2)
    assert.deepEqual(events.filter(event => event.kind === 'result').map(event => [event.inputId, event.operationRef, event.outcome]),
      [['TEST-input1', 'TEST-op1', 'succeeded'], ['TEST-input2', 'TEST-op2', 'succeeded']])
    assert.equal(host.counts().submitted, 2)
    assert.equal(session.checkpoint().ok, true)
  } finally { await session.close(); await observed }
  for (const requestRejection of [400, 422] as const) {
    const rejectedHost = await driverPeer({ requestRejection }); t.after(rejectedHost.close)
    const rejectedConfig = nativeConfig(rejectedHost); rejectedConfig.version = '2.1.4'
    const rejected = createV2DriverSession(rejectedConfig), failedEvents: Event[] = []
    const done = (async () => { for await (const event of rejected.observe()) { failedEvents.push(event) } })()
    try {
      assert.equal((await rejected.submit({ inputId: 'TEST-rejected', operationRef: 'TEST-rejected-op', content: 'TEST rejected request' })).ok, true)
      await until(() => failedEvents.some(event => event.kind === 'result'))
      assert.deepEqual(failedEvents.find(event => event.kind === 'result'), {
        kind: 'result', outcome: 'failed', code: 'unsupported', sessionRef: rejected.sessionRef,
        inputId: 'TEST-rejected', operationRef: 'TEST-rejected-op',
      })
      assert.equal(JSON.stringify(failedEvents).includes('TEST private provider error'), false)
      assert.equal(rejectedHost.counts().submitted, 1); assert.equal(rejectedHost.counts().interrupted, 0)
    } finally { await rejected.close(); await done }
  }
})

test('lost native handoff seals session, rejects unsent neighbor, and never replays mutation', async t => {
  const host = await driverPeer(); host.loseReceipt(); t.after(host.close)
  const session = createV2DriverSession(nativeConfig(host)), events: Event[] = []
  const observed = (async () => { for await (const event of session.observe()) {events.push(event)} })()
  try {
    const first = session.submit({ inputId: 'TEST-input1', operationRef: 'TEST-op1', content: 'TEST first' })
    const second = session.submit({ inputId: 'TEST-input2', operationRef: 'TEST-op2', content: 'TEST second' })
    assert.deepEqual(await first, { ok: false, code: 'unknown' })
    assert.deepEqual(await second, { ok: false, code: 'unknown', delivery: 'known-not-sent' })
    await observed
    assert.equal(events.filter(event => event.kind === 'result' && event.outcome === 'unknown').length, 1)
    assert.equal(session.checkpoint().ok, false)
    assert.equal(host.counts().submitted, 1)
  } finally { await session.close() }
})

test('malformed post-ACK native V2 envelope seals original UNKNOWN and never replays or submits its neighbor', async t => {
  const host = await driverPeer(); host.flatPrompt(); t.after(host.close)
  const session = createV2DriverSession(nativeConfig(host)), events: Event[] = []
  const observed = (async () => { for await (const event of session.observe()) {events.push(event)} })()
  try {
    const first = session.submit({ inputId: 'TEST-ack1', operationRef: 'TEST-op1', content: 'TEST first' })
    const second = session.submit({ inputId: 'TEST-ack2', operationRef: 'TEST-op2', content: 'TEST second' })
    assert.deepEqual(await first, { ok: false, code: 'unknown' })
    assert.deepEqual(await second, { ok: false, code: 'unknown', delivery: 'known-not-sent' })
    await observed
    assert.equal(events.filter(event => event.kind === 'result' && event.outcome === 'unknown').length, 1)
    assert.equal(session.checkpoint().ok, false)
    assert.equal(host.counts().submitted, 1)
    assert.equal(host.submittedIds.length, 1)
  } finally { await session.close() }
})

test('actual native permission is independent of turn polling, bound to original input, and replied once', async t => {
  const host = await driverPeer(); host.permission(); t.after(host.close)
  const session = createV2DriverSession(nativeConfig(host)), events: Event[] = []
  const observed = (async () => { for await (const event of session.observe()) {events.push(event)} })()
  try {
    assert.equal((await session.submit({ inputId: 'TEST-permission', operationRef: 'TEST-op', content: 'TEST permission' })).ok, true)
    await until(() => events.some(event => event.kind === 'interaction'))
    const interaction = events.find(event => event.kind === 'interaction'); assert.ok(interaction?.kind === 'interaction')
    assert.equal(interaction.inputId, 'TEST-permission'); assert.equal(interaction.operationRef, 'TEST-op')
    assert.deepEqual(await session.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: true, value: undefined })
    assert.deepEqual(await session.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: false, code: 'stale' })
    await until(() => events.some(event => event.kind === 'result' && event.outcome === 'succeeded'))
    assert.equal(host.counts().replies, 1)
  } finally { await session.close(); await observed }
})

test('a delayed scoped interrupt fences the next input even after the original turn reaches terminal', async t => {
  const host = await driverPeer(); host.permission(); host.pauseInterrupt(); t.after(host.close)
  const session = createV2DriverSession(nativeConfig(host)), events: Event[] = []
  const observed = (async () => { for await (const event of session.observe()) {events.push(event)} })()
  try {
    assert.equal((await session.submit({ inputId: 'TEST-first', operationRef: 'TEST-op1', content: 'TEST first' })).ok, true)
    const second = session.submit({ inputId: 'TEST-second', operationRef: 'TEST-op2', content: 'TEST second' })
    const cancel = session.interrupt('TEST-op1')
    await until(() => host.counts().interrupted === 1)
    host.complete()
    await until(() => events.some(event => event.kind === 'result' && event.inputId === 'TEST-first'))
    await delay(40); assert.equal(host.counts().submitted, 1)
    host.releaseInterrupt(); assert.deepEqual(await cancel, { ok: true, value: { requested: true, terminal: 'unconfirmed' } })
    assert.equal((await second).ok, true)
    assert.deepEqual(await session.interrupt('TEST-op1'), { ok: false, code: 'stale' })
    assert.equal(host.counts().interrupted, 1)
    host.complete()
    await until(() => events.filter(event => event.kind === 'result').length === 2)
  } finally { host.releaseInterrupt(); await session.close(); await observed }
})

test('output backpressure preserves an already qualified terminal in the reserved frame and prevents neighbor handoff', async t => {
  const host = await driverPeer(); t.after(host.close)
  const config = nativeConfig(host); config.limits = { ...config.limits, outputEvents: 1 }
  const session = createV2DriverSession(config)
  try {
    assert.equal((await session.submit({ inputId: 'TEST-first', operationRef: 'TEST-op1', content: 'TEST first' })).ok, true)
    const second = session.submit({ inputId: 'TEST-second', operationRef: 'TEST-op2', content: 'TEST second' })
    const events: Event[] = []
    for await (const event of session.observe()) {events.push(event)}
    assert.deepEqual(await second, { ok: false, code: 'output-limit', delivery: 'known-not-sent' })
    const terminal = events.find(event => event.kind === 'result'); assert.ok(terminal?.kind === 'result')
    assert.equal(terminal.outcome, 'succeeded'); assert.equal(terminal.code, 'output-limit')
    assert.equal(host.counts().submitted, 1)
  } finally { await session.close() }
})

test('logical close is immediate and reports unknown cleanup without Host stop evidence', async t => {
  const host = await driverPeer(); host.hold(); t.after(host.close)
  const config = nativeConfig(host); config.confirmStopped = async () => false
  const session = createV2DriverSession(config)
  assert.equal((await session.submit({ inputId: 'TEST-first', operationRef: 'TEST-op1', content: 'TEST first' })).ok, true)
  const closing = session.close()
  assert.deepEqual(await session.submit({ inputId: 'TEST-second', operationRef: 'TEST-op2', content: 'TEST second' }),
    { ok: false, code: 'unavailable', delivery: 'known-not-sent' })
  assert.deepEqual(await closing, { logicallyClosed: true, cleanup: 'unknown' })
  assert.equal(host.counts().submitted, 1)
})

test('interrupt of an undelivered native input cancels only its exact inbox and preserves a shared-host neighbor', async t => {
  const host = await driverPeer(); host.hold(); t.after(host.close)
  const session = createV2DriverSession(nativeConfig(host)), events: Event[] = []
  const observed = (async () => { for await (const event of session.observe()) {events.push(event)} })()
  try {
    assert.equal((await session.submit({ inputId: 'TEST-queued', operationRef: 'TEST-op', content: 'TEST queued' })).ok, true)
    assert.deepEqual(await session.interrupt('TEST-op'), { ok: true, value: { requested: true, terminal: 'unconfirmed' } })
    await until(() => events.some(event => event.kind === 'result'))
    const result = events.find(event => event.kind === 'result'); assert.ok(result?.kind === 'result'); assert.equal(result.outcome, 'cancelled')
    assert.equal(host.cancelled.length, 1); assert.match(host.cancelled[0]!, /^msg_[a-f0-9]+$/)
    assert.equal(host.counts().interrupted, 0)
    assert.deepEqual([...host.neighborInbox], ['msg_TESTunrelated'])
    assert.equal(host.counts().submitted, 1)
  } finally { await session.close(); await observed }
})

test('permission list held across a completed interrupt ACK cannot resurrect interaction or authorize a reply', async t => {
  const host = await driverPeer(); host.permission(); host.pausePermissions(); t.after(host.close)
  const session = createV2DriverSession(nativeConfig(host)), events: Event[] = []
  const observed = (async () => { for await (const event of session.observe()) {events.push(event)} })()
  try {
    assert.equal((await session.submit({ inputId: 'TEST-cancelled', operationRef: 'TEST-op', content: 'TEST cancelled' })).ok, true)
    await until(() => host.permissionLists() === 1)
    assert.deepEqual(await session.interrupt('TEST-op'), { ok: true, value: { requested: true, terminal: 'unconfirmed' } })
    const reads = host.sessionReads()
    host.releasePermissions()
    // The next cut starts only after the held permission response has been processed.
    await until(() => host.sessionReads() > reads)
    const ref = host.submittedIds[0] + ':per_TESTpermission'
    assert.deepEqual(await session.respondToInteraction(ref, { kind: 'permission', decision: 'allow' }), { ok: false, code: 'stale' })
    assert.equal(events.some(event => event.kind === 'interaction'), false)
    assert.equal(host.counts().replies, 0)
    host.complete()
    await until(() => events.some(event => event.kind === 'result' && event.inputId === 'TEST-cancelled'))
    assert.equal((await session.submit({ inputId: 'TEST-next', operationRef: 'TEST-next-op', content: 'TEST next' })).ok, true)
    await until(() => events.some(event => event.kind === 'interaction' && event.inputId === 'TEST-next'))
    const next = events.find(event => event.kind === 'interaction' && event.inputId === 'TEST-next')
    assert.ok(next?.kind === 'interaction')
    assert.deepEqual(await session.respondToInteraction(next.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: true, value: undefined })
    await until(() => events.some(event => event.kind === 'result' && event.inputId === 'TEST-next'))
    assert.equal(host.counts().replies, 1)
  } finally { host.releasePermissions(); await session.close(); await observed }
})

test('unqualified native execution lineage cannot authorize permissions, while the next qualified turn works', async t => {
  const host = await driverPeer(); host.permission(); host.unknownLineage(); t.after(host.close)
  const session = createV2DriverSession(nativeConfig(host)), events: Event[] = []
  const observed = (async () => { for await (const event of session.observe()) {events.push(event)} })()
  try {
    assert.equal((await session.submit({ inputId: 'TEST-unknown', operationRef: 'TEST-op', content: 'TEST unknown' })).ok, true)
    await until(() => host.sessionReads() >= 6)
    assert.equal(events.some(event => event.kind === 'interaction'), false)
    const ref = host.submittedIds[0] + ':per_TESTpermission'
    assert.deepEqual(await session.respondToInteraction(ref, { kind: 'permission', decision: 'allow' }), { ok: false, code: 'stale' })
    assert.equal(host.permissionLists(), 0); assert.equal(host.counts().replies, 0)
    host.validLineage(); host.complete()
    await until(() => events.some(event => event.kind === 'result' && event.inputId === 'TEST-unknown'))
    assert.equal((await session.submit({ inputId: 'TEST-valid', operationRef: 'TEST-valid-op', content: 'TEST valid' })).ok, true)
    await until(() => events.some(event => event.kind === 'interaction' && event.inputId === 'TEST-valid'))
    const next = events.find(event => event.kind === 'interaction' && event.inputId === 'TEST-valid')
    assert.ok(next?.kind === 'interaction')
    assert.deepEqual(await session.respondToInteraction(next.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: true, value: undefined })
    await until(() => events.some(event => event.kind === 'result' && event.inputId === 'TEST-valid'))
    assert.equal(host.counts().replies, 1)
  } finally { await session.close(); await observed }
})

test('interrupt revokes an already pending permission reply preflight before its grant POST', async t => {
  const host = await driverPeer(); host.permission(); t.after(host.close)
  const session = createV2DriverSession(nativeConfig(host)), events: Event[] = []
  const observed = (async () => { for await (const event of session.observe()) {events.push(event)} })()
  try {
    assert.equal((await session.submit({ inputId: 'TEST-reply', operationRef: 'TEST-op', content: 'TEST reply' })).ok, true)
    await until(() => events.some(event => event.kind === 'interaction'))
    const interaction = events.find(event => event.kind === 'interaction'); assert.ok(interaction?.kind === 'interaction')
    host.pauseReplyPreflight()
    const reply = session.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: 'allow' })
    await until(() => host.permissionDetails() === 1)
    assert.deepEqual(await session.interrupt('TEST-op'), { ok: true, value: { requested: true, terminal: 'unconfirmed' } })
    assert.deepEqual(await reply, { ok: false, code: 'stale' })
    host.releaseReplyPreflight(); await delay(20)
    assert.equal(host.counts().replies, 0)
    host.complete()
    await until(() => events.some(event => event.kind === 'result' && event.inputId === 'TEST-reply'))
    assert.equal((await session.submit({ inputId: 'TEST-valid', operationRef: 'TEST-valid-op', content: 'TEST valid' })).ok, true)
    await until(() => events.some(event => event.kind === 'interaction' && event.inputId === 'TEST-valid'))
    const next = events.find(event => event.kind === 'interaction' && event.inputId === 'TEST-valid'); assert.ok(next?.kind === 'interaction')
    assert.deepEqual(await session.respondToInteraction(next.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: true, value: undefined })
    await until(() => events.some(event => event.kind === 'result' && event.inputId === 'TEST-valid'))
    assert.equal(host.counts().replies, 1)
  } finally { host.releaseReplyPreflight(); await session.close(); await observed }
})

test('revocation after a native grant POST started retains uncertainty and prevents next handoff', async t => {
  const host = await driverPeer(); host.permission(); host.pauseGrant(); t.after(host.close)
  const session = createV2DriverSession(nativeConfig(host)), events: Event[] = []
  const observed = (async () => { for await (const event of session.observe()) {events.push(event)} })()
  try {
    assert.equal((await session.submit({ inputId: 'TEST-reply', operationRef: 'TEST-op', content: 'TEST reply' })).ok, true)
    await until(() => events.some(event => event.kind === 'interaction'))
    const interaction = events.find(event => event.kind === 'interaction'); assert.ok(interaction?.kind === 'interaction')
    const reply = session.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: 'allow' })
    await until(() => host.counts().replies === 1)
    const next = session.submit({ inputId: 'TEST-next', operationRef: 'TEST-next-op', content: 'TEST next' })
    await session.interrupt('TEST-op')
    assert.deepEqual(await reply, { ok: false, code: 'unknown' })
    assert.deepEqual(await next, { ok: false, code: 'unknown', delivery: 'known-not-sent' })
    assert.equal(host.counts().submitted, 1); assert.equal(host.counts().replies, 1)
  } finally { host.releaseGrant(); await session.close(); await observed }
})

test('observed terminal revokes a held permission reply preflight before grant and admits valid next turn', async t => {
  const host = await driverPeer(); host.permission(); t.after(host.close)
  const session = createV2DriverSession(nativeConfig(host)), events: Event[] = []
  const observed = (async () => { for await (const event of session.observe()) {events.push(event)} })()
  try {
    assert.equal((await session.submit({ inputId: 'TEST-terminal', operationRef: 'TEST-op', content: 'TEST terminal' })).ok, true)
    await until(() => events.some(event => event.kind === 'interaction'))
    const interaction = events.find(event => event.kind === 'interaction'); assert.ok(interaction?.kind === 'interaction')
    host.pauseReplyPreflight()
    const reply = session.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: 'allow' })
    await until(() => host.permissionDetails() === 1)
    host.complete()
    await until(() => events.some(event => event.kind === 'result' && event.inputId === 'TEST-terminal'))
    host.releaseReplyPreflight()
    assert.deepEqual(await reply, { ok: false, code: 'stale' })
    assert.equal(host.counts().replies, 0)
    assert.equal((await session.submit({ inputId: 'TEST-next', operationRef: 'TEST-next-op', content: 'TEST next' })).ok, true)
    await until(() => events.some(event => event.kind === 'interaction' && event.inputId === 'TEST-next'))
    const next = events.find(event => event.kind === 'interaction' && event.inputId === 'TEST-next'); assert.ok(next?.kind === 'interaction')
    assert.deepEqual(await session.respondToInteraction(next.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: true, value: undefined })
    await until(() => events.some(event => event.kind === 'result' && event.inputId === 'TEST-next'))
    assert.equal(host.counts().replies, 1)
  } finally { host.releaseReplyPreflight(); await session.close(); await observed }
})

type CloseDiagnosticCase = 'original-work' | 'protocol-dispose' | 'confirm-false' | 'confirm-throw' | 'confirmed' | 'truthy'
function closeDiagnosticFixture(mode: CloseDiagnosticCase,
  alter: (config: DriverSessionConfig) => DriverSessionConfig = value => value) {
  const calls: string[] = []
  let releaseQueue!: () => void, signal!: AbortSignal, queued = false, queueReturned = false
  const heldQueue = new Promise<void>(resolve => { releaseQueue = resolve })
  const config = alter({
    binding: { tenantId: 'TEST-tenant', projectId: 'TEST-project', sessionId: 'TEST-close-session', generation: 1 },
    nativeSessionId: 'ses_TESTclose', trustedBinding: 'a'.repeat(64), engine: 'opencode-v2', compatibility: 'TEST-close',
    limits: { queuedInputs: 2, inputBytes: 4096, outputBytes: 100_000, outputEvents: 100, pendingInteractions: 2, timeoutMs: 50 },
    probe: async () => true,
    confirmStopped: async () => {
      calls.push('confirm-stopped')
      if (mode === 'confirm-throw') throw new Error('TEST_PRIVATE_STOP_FAILURE')
      return mode === 'truthy' ? 1 as unknown as boolean : mode === 'confirmed'
    },
  })
  const session = new OpenCodeDriverSession(config, ownerSignal => {
    signal = ownerSignal
    return {
      pollIntervalMs: 1,
      async queue() {
        calls.push('queue'); queued = true
        await heldQueue; queueReturned = true
        return { nativeInputId: 'msg_TESTclose', read: async () => ({ facts: [], permissions: [] }), interrupt: async () => {} }
      },
      async replyPermission() { assert.fail('the close fixture must never grant a permission') },
      async dispose() {
        calls.push('protocol-dispose')
        if (mode === 'protocol-dispose') throw new Error('TEST_PRIVATE_DISPOSE_FAILURE')
      },
    }
  })
  return { session, calls, signal, releaseQueue, queued: () => queued, queueReturned: () => queueReturned }
}

test('V2 close diagnostics retain each original failed stage, cached Promise and downstream call order', async t => {
  const diagnostics: unknown[] = [], events = channel('agent-teams:opencode-v2:driver-close-failed')
  const collect = (value: unknown) => { diagnostics.push(value) }
  events.subscribe(collect); t.after(() => { events.unsubscribe(collect) })
  for (const mode of ['original-work', 'protocol-dispose', 'confirm-false', 'confirm-throw', 'confirmed', 'truthy'] as const) {
    diagnostics.length = 0
    const f = closeDiagnosticFixture(mode), observed: Event[] = []
    const observation = (async () => { for await (const event of f.session.observe()) observed.push(event) })()
    try {
      assert.equal(f.signal.aborted, false)
      if (mode === 'original-work') {
        void f.session.submit({ inputId: 'TEST-close-input', operationRef: 'TEST-close-op', content: 'TEST close input' })
        await until(f.queued)
      }
      const closing = f.session.close()
      assert.equal(f.signal.aborted, true)
      assert.equal(f.session.close(), closing, 'close preserves its original cached Promise')
      const confirmed = mode === 'confirmed' || mode === 'truthy'
      assert.deepEqual(await closing, { logicallyClosed: true, cleanup: confirmed ? 'confirmed' : 'unknown' })
      assert.equal(f.session.close(), closing)
      await observation
      assert.deepEqual(observed, mode === 'original-work'
        ? [{ kind: 'result', outcome: 'unknown', code: 'unknown', sessionRef: 'TEST-close-session', inputId: 'TEST-close-input', operationRef: 'TEST-close-op' }]
        : [{ kind: 'diagnostic', code: 'unknown', sessionRef: 'TEST-close-session' }])
      assert.deepEqual(f.calls, mode === 'original-work' ? ['queue'] : mode === 'protocol-dispose'
        ? ['protocol-dispose'] : ['protocol-dispose', 'confirm-stopped'])
      if (confirmed) assert.deepEqual(diagnostics, [])
      else {
        assert.equal(diagnostics.length, 1)
        const diagnostic = diagnostics[0]
        assert.equal(Object.isFrozen(diagnostic), true)
        assert.deepEqual(diagnostic, { stage: mode === 'original-work' ? 'original-work'
          : mode === 'protocol-dispose' ? 'protocol-dispose' : 'confirm-stopped',
        outcome: mode === 'confirm-false' ? 'unconfirmed' : 'threw', trustedBinding: 'a'.repeat(64) })
      }
      assert.equal(JSON.stringify(diagnostics).includes('TEST_PRIVATE'), false)
    } finally {
      f.releaseQueue()
      if (f.queued()) await until(f.queueReturned)
      await f.session.close(); await observation
    }
  }
})

test('close diagnostics refuse V1 and non-data or malformed metadata without reading accessors', async t => {
  const diagnostics: unknown[] = [], events = channel('agent-teams:opencode-v2:driver-close-failed')
  const collect = (value: unknown) => { diagnostics.push(value) }
  events.subscribe(collect); t.after(() => { events.unsubscribe(collect) })
  for (const mode of ['v1', 'missing-engine', 'inherited-engine', 'engine-accessor', 'missing-binding',
    'inherited-binding', 'binding-accessor', 'object-binding', 'uppercase-binding', 'short-binding', 'descriptor-throws'] as const) {
    let getters = 0, descriptorReads = 0
    const f = closeDiagnosticFixture('confirm-false', config => {
      if (mode === 'v1') config.engine = 'opencode-v1'
      if (mode === 'missing-engine' || mode === 'inherited-engine') {
        Reflect.deleteProperty(config, 'engine')
        if (mode === 'inherited-engine') Object.setPrototypeOf(config, { engine: 'opencode-v2' })
      }
      if (mode === 'engine-accessor' || mode === 'binding-accessor') Object.defineProperty(config,
        mode === 'engine-accessor' ? 'engine' : 'trustedBinding', {
          get() { getters++; throw new Error('TEST_PRIVATE_CONFIG_ACCESSOR') },
        })
      if (mode === 'missing-binding' || mode === 'inherited-binding') {
        Reflect.deleteProperty(config, 'trustedBinding')
        if (mode === 'inherited-binding') Object.setPrototypeOf(config, { trustedBinding: 'a'.repeat(64) })
      }
      if (mode === 'object-binding') config.trustedBinding = { toString() {
        getters++; throw new Error('TEST_PRIVATE_BINDING_COERCION')
      } } as unknown as string
      if (mode === 'uppercase-binding') config.trustedBinding = 'A'.repeat(64)
      if (mode === 'short-binding') config.trustedBinding = 'a'.repeat(63)
      return mode === 'descriptor-throws' ? new Proxy(config, {
        getOwnPropertyDescriptor() { descriptorReads++; throw new Error('TEST_PRIVATE_DESCRIPTOR_FAILURE') },
      }) : config
    })
    try {
      assert.deepEqual(await f.session.close(), { logicallyClosed: true, cleanup: 'unknown' })
      assert.deepEqual(f.calls, ['protocol-dispose', 'confirm-stopped'])
      const observed: Event[] = []
      for await (const event of f.session.observe()) observed.push(event)
      assert.deepEqual(observed, [{ kind: 'diagnostic', code: 'unknown', sessionRef: 'TEST-close-session' }])
      assert.equal(getters, 0); assert.equal(descriptorReads, mode === 'descriptor-throws' ? 1 : 0)
      assert.deepEqual(diagnostics, [])
    } finally { f.releaseQueue(); await f.session.close() }
  }
})

test('absent subscribers and producer-side publication failure preserve the original unknown close', async t => {
  const events = channel('agent-teams:opencode-v2:driver-close-failed')
  assert.equal(events.hasSubscribers, false)
  let descriptorReads = 0
  const silent = closeDiagnosticFixture('confirm-false', config => new Proxy(config, {
    getOwnPropertyDescriptor() { descriptorReads++; throw new Error('TEST_PRIVATE_UNUSED_DESCRIPTOR') },
  }))
  try {
    assert.deepEqual(await silent.session.close(), { logicallyClosed: true, cleanup: 'unknown' })
    assert.equal(descriptorReads, 0); assert.deepEqual(silent.calls, ['protocol-dispose', 'confirm-stopped'])
  } finally { silent.releaseQueue(); await silent.session.close() }
  const collect = () => {}
  events.subscribe(collect); t.after(() => { events.unsubscribe(collect) })
  let publications = 0
  const published: unknown[] = []
  // This exercises a publisher failure, not an arbitrary subscriber's uncaughtException semantics.
  const publish = t.mock.method(events, 'publish', (value: unknown) => {
    publications++; published.push(value); throw new Error('TEST_PRIVATE_PUBLISH_FAILURE')
  })
  const f = closeDiagnosticFixture('confirm-false')
  try {
    const closing = f.session.close()
    assert.deepEqual(await closing, { logicallyClosed: true, cleanup: 'unknown' })
    assert.equal(f.session.close(), closing); assert.equal(publications, 1)
    assert.deepEqual(f.calls, ['protocol-dispose', 'confirm-stopped'])
    assert.deepEqual(published, [{ stage: 'confirm-stopped', outcome: 'unconfirmed', trustedBinding: 'a'.repeat(64) }])
    const observed: Event[] = []
    for await (const event of f.session.observe()) observed.push(event)
    assert.deepEqual(observed, [{ kind: 'diagnostic', code: 'unknown', sessionRef: 'TEST-close-session' }])
  } finally { publish.mock.restore(); f.releaseQueue(); await f.session.close() }
})
