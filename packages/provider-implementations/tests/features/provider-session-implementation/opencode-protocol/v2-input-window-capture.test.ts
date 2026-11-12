import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { TestContext } from 'node:test'
import type { Event } from '@agent-teams/provider-session-contracts'
import { createOpenCodeV2DriverFactory } from '../../../../src/opencode.ts'
import type { OpenCodeInputWindowPort, OpenCodeInputWindowRequest, OpenCodeV2InputWindowItem } from '../../../../src/opencode.ts'
import { OpenCodeInputWindowCapture } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/input-window-capture.ts'
import { snapshotDriverConfig } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-driver-config.ts'
import { nativeConfig } from './v2-driver-support.ts'
import { driverPeer } from './v2-driver-peer.ts'

function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve }), release: () => release() } }
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000
  while (!predicate()) { assert(Date.now() < deadline, 'TEST capture deadline'); await delay(5) }
}
const input = (n = 1) => ({ inputId: `TEST-input-${n}`, operationRef: `TEST-op-${n}`, content: `TEST message ${n}` })
async function fixture(t: TestContext, capture: OpenCodeInputWindowPort, timeoutMs = 2000) {
  const peer = await driverPeer({ nativeEdit: true }); t.after(peer.close)
  const config = { ...nativeConfig(peer), version: '2.1.4' as const, capture }
  config.limits = { ...config.limits, timeoutMs }
  const request = { ...config.binding, configRevision: config.configRevision, requiredCapabilities: ['text', 'tools'] }
  const factory = createOpenCodeV2DriverFactory({ capabilities: ['text', 'tools', 'interrupt'],
    resolveConfiguration: async () => config, readCheckpoint: async () => null })
  const { driver } = await factory.open(request)
  const events: Event[] = [], observed = (async () => { for await (const event of driver.observe()) { events.push(event) } })()
  t.after(async () => { await driver.close(); await observed })
  return { peer, config, request, driver, events }
}

test('V2 captures one immutable original input window with real event anchors before permitting its neighbor', async t => {
  const before = gate(), after = gate(), requests: OpenCodeInputWindowRequest[] = []
  let methodReads = 0
  const port = { get observe() { methodReads++; return async (value: OpenCodeInputWindowRequest) => {
    requests.push(value)
    if (value.inputId !== 'TEST-input-1') { return }
    if (value.phase === 'before') { await before.promise }
    if (value.phase === 'after') { await after.promise }
  } } }
  const f = await fixture(t, port)
  assert.equal(methodReads, 1)
  const mutable = input(), first = f.driver.submit(mutable)
  mutable.operationRef = 'TEST-mutation'; mutable.content = 'TEST-mutation'
  await until(() => requests.length > 0)
  assert.equal(f.peer.counts().submitted, 0)
  assert.equal(requests[0]?.dialect, 'v2')
  before.release(); assert.equal((await first).ok, true)
  const second = f.driver.submit(input(2))
  await until(() => requests.some(row => row.phase === 'after'))
  const terminal = requests.find(row => row.phase === 'after')
  assert.ok(terminal?.phase === 'after' && terminal.dialect === 'v2')
  assert.equal(terminal.operationRef, 'TEST-op-1'); assert.equal(terminal.beforeObserved, true)
  assert.equal(terminal.gapReason, undefined); assert.equal(terminal.nativeSessionId, f.peer.sessionId)
  assert.equal(terminal.nativeInputId, f.peer.submittedIds[0]); assert.equal(terminal.items.length, 1)
  const item = terminal.items[0]!, actual = f.peer.outputs.get(terminal.nativeInputId)!
  const called = actual.log.events.find(row => row.type === 'session.tool.called')!
  const success = actual.log.events.find(row => row.type === 'session.tool.success')!
  assert.equal(item.dialect, 'v2'); assert.equal(item.protocolRevision, '2.1.4')
  assert.equal(item.status, 'completed'); assert.equal(item.providerExecuted, false); assert.equal(item.tool, 'edit')
  assert.deepEqual(item.calledEvent, { id: called.id, seq: called.seq })
  assert.deepEqual(item.completedEvent, { id: success.id, seq: success.seq, type: success.type })
  assert.equal(item.messageId, success.data.assistantMessageID); assert.equal(item.callId, success.data.id)
  assert.deepEqual(item.input, called.data.input); assert.deepEqual(item.metadata, success.data.metadata)
  assert.ok(Object.isFrozen(terminal) && Object.isFrozen(item) && Object.isFrozen(item.metadata) && Object.isFrozen(item.completedEvent))
  assert.equal(Object.hasOwn(item, 'partId'), false); assert.equal(Object.hasOwn(item, 'startedAt'), false)
  assert.equal(f.peer.counts().submitted, 1); assert.equal(f.events.some(row => row.kind === 'result'), false)
  after.release(); assert.equal((await second).ok, true)
  await until(() => f.events.filter(row => row.kind === 'result').length === 2)
  assert.equal(terminal.signal.aborted, true); assert.equal(requests[0]!.signal.aborted, true)
  assert.equal(methodReads, 1)
  const next = requests.find(row => row.inputId === 'TEST-input-2' && row.phase === 'after')
  assert.ok(next?.phase === 'after'); assert.notEqual(next.windowRef, terminal.windowRef)
  assert.notEqual(next.nativeInputId, terminal.nativeInputId)
})

test('V2 observer failure or deadline yields a gap while the original native work still completes once', async t => {
  for (const mode of ['throw', 'timeout'] as const) {
    const requests: OpenCodeInputWindowRequest[] = [], delayed = gate()
    const f = await fixture(t, { observe: async value => {
      requests.push(value)
      if (value.phase === 'before' && mode === 'timeout') { await delayed.promise }
      else if (value.phase !== 'after') { throw new Error('TEST observer failure') }
    } }, mode === 'timeout' ? 250 : 2000)
    assert.equal((await f.driver.submit(input())).ok, true)
    delayed.release()
    await until(() => f.events.some(row => row.kind === 'result'))
    const terminal = requests.find(row => row.phase === 'after')
    assert.ok(terminal?.phase === 'after' && terminal.dialect === 'v2')
    assert.equal(terminal.beforeObserved, false)
    assert.equal(terminal.gapReason, mode === 'timeout' ? 'timeout' : 'capture-failed')
    assert.equal(terminal.outcome, 'succeeded'); assert.equal(f.peer.counts().submitted, 1)
    assert.ok(f.events.some(row => row.kind === 'result' && row.outcome === 'succeeded'))
    assert.equal(requests[0]!.signal.aborted, true)
  }
})

test('V2 close during baseline observation never posts a late original input', async t => {
  const delayed = gate(), requests: OpenCodeInputWindowRequest[] = []
  const f = await fixture(t, { observe: async value => { requests.push(value); if (value.phase === 'before') { await delayed.promise } } })
  const submitted = f.driver.submit(input())
  await until(() => requests.length > 0)
  await f.driver.close(); delayed.release()
  assert.deepEqual(await submitted, { ok: false, code: 'unknown', delivery: 'known-not-sent' })
  assert.equal(f.peer.counts().submitted, 0); assert.equal(requests[0]!.signal.aborted, true)
  assert.equal(requests.some(row => row.phase === 'after'), false)
})

test('V2 capture rejects synthetic part identities, reversed event anchors and a mixed dialect as a bounded gap', async () => {
  const valid: OpenCodeV2InputWindowItem = { dialect: 'v2', protocolRevision: '2.1.4', messageId: 'msg_TESTassistant',
    callId: 'TEST-tool', tool: 'edit', status: 'completed', providerExecuted: false, input: {}, metadata: {},
    calledEvent: { id: 'evt_TEST1', seq: 1 }, completedEvent: { id: 'evt_TEST2', seq: 2, type: 'session.tool.success' } }
  for (const change of [item => { Reflect.set(item, 'partId', 'prt_FAKE') }, item => { item.completedEvent = { ...item.completedEvent, seq: 0 } },
    item => { Reflect.deleteProperty(item, 'dialect') } ] as Array<(item: { -readonly [K in keyof OpenCodeV2InputWindowItem]: OpenCodeV2InputWindowItem[K] }) => void>) {
    const items: OpenCodeInputWindowRequest[] = [], item = structuredClone(valid); change(item)
    const capture = new OpenCodeInputWindowCapture({ identity: { dialect: 'v2', sessionRef: 'TEST', windowRef: 'TEST-window',
      inputId: 'TEST-input', operationRef: 'TEST-op', nativeSessionId: 'ses_TEST' }, port: { observe: value => { items.push(value) } },
      abort: new AbortController().signal, timeoutMs: 100, maxItems: 1, maxBytes: 4096 })
    await capture.before(); await capture.after('msg_TEST', 'succeeded', [item])
    const terminal = items.find(row => row.phase === 'after'); assert.ok(terminal?.phase === 'after')
    assert.equal(terminal.gapReason, 'limit'); assert.deepEqual(terminal.items, [])
  }
})

test('V2 config captures the optional port getter once, including initially absent ports', async t => {
  const f = await fixture(t, { observe() {} })
  let reads = 0
  Object.defineProperty(f.config, 'capture', { enumerable: true, get() { return ++reads === 1 ? undefined : { observe() { throw new Error('TEST unsnapshotted') } } } })
  const captured = snapshotDriverConfig(f.config, f.request)
  assert.equal(reads, 1); assert.equal(Object.hasOwn(captured, 'capture'), false)
})
