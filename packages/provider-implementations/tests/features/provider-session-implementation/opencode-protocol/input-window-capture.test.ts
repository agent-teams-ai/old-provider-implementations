import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { Event, OpenConfig } from '@agent-teams/provider-session-contracts'
import { createOpenCodeV1DriverFactory } from '../../../../src/opencode.ts'
import type { OpenCodeV1DriverConfig } from '../../../../src/opencode.ts'
import type { OpenCodeInputWindowPort, OpenCodeInputWindowRequest } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/input-window-capture.ts'
import { v1Peer } from './v1-driver-peer.ts'
const request: OpenConfig = { tenantId: 'TEST', projectId: 'TEST', sessionId: 'TEST', generation: 1, configRevision: 'TEST', requiredCapabilities: ['text'] }
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve }), release: () => release() } }
async function until(predicate: () => boolean) { const deadline = Date.now() + 3000; while (!predicate()) { assert(Date.now() < deadline); await delay(5) } }
async function fixture(t: TestContext, capture: OpenCodeInputWindowPort, timeoutMs = 1000) {
  const host = await v1Peer(); t.after(host.close)
  const config: OpenCodeV1DriverConfig = { endpoint: host.endpoint, workspacePath: host.directory, nativeSessionId: host.nativeSessionId, version: '1.19.4',
    binding: request, configRevision: request.configRevision, trustedBinding: 'TEST', accountBinding: 'TEST', profileBinding: 'TEST', runBinding: 'TEST', model: { providerID: 'TEST-provider', modelID: 'TEST-model' },
    limits: { queuedInputs: 2, inputBytes: 4096, outputEvents: 100, outputBytes: 100_000, pendingInteractions: 2, timeoutMs }, probe: async () => true, confirmStopped: async () => true, capture }
  const factory = createOpenCodeV1DriverFactory({ capabilities: ['text', 'tools', 'interrupt'], resolveConfiguration: async () => config, readCheckpoint: async () => null })
  const { driver } = await factory.open(request)
  const events: Event[] = []; const done = (async () => { for await (const event of driver.observe()) {events.push(event)} })()
  t.after(async () => { await driver.close(); await done })
  return { host, driver, events, config }
}
const input = (n = 1) => ({ inputId: `TEST-input-${n}`, operationRef: `TEST-op-${n}`, content: `TEST message ${n}` })

test('before blocks prompt_async; exact terminal carries edit metadata/part anchors before next input and snapshots identities', async t => {
  const before = gate(), after = gate(); const requests: OpenCodeInputWindowRequest[] = []
  const port: OpenCodeInputWindowPort = { observe: async value => { requests.push(value); if (value.inputId !== 'TEST-input-1') {return}; if (value.phase === 'before') {await before.promise}; if (value.phase === 'after') {await after.promise} } }
  const a = await fixture(t, port); a.host.hold()
  port.observe = () => {throw new Error('not captured')}
  const mutable = input(); const accepted = a.driver.submit(mutable); mutable.operationRef = 'changed'; mutable.content = 'changed'
  await until(() => requests.length === 1); assert.equal(a.host.submittedIds.length, 0)
  before.release(); assert((await accepted).ok)
  assert.equal((a.host.submittedParts[0]![0] as { text: string }).text, 'TEST message 1')
  const queued = a.driver.submit(input(2))
  const message = a.host.messages.at(-1)!, tool = message.parts.find(part => part.type === 'tool')!
  const metadata = { diff: '@@ -1 +1 @@\n-dirty\n+new\n', filediff: { file: '/TEST/dirty.txt', patch: '@@ -1 +1 @@\n-dirty\n+new\n', additions: 1, deletions: 1 }, truncated: false }
  tool.tool = 'edit'; tool.state = { ...(tool.state as object), input: { filePath: '/TEST/dirty.txt', oldString: 'dirty', newString: 'new' }, metadata }
  a.host.complete(); await until(() => requests.some(value => value.phase === 'after'))
  const final = requests.find(value => value.phase === 'after'); assert(final?.phase === 'after')
  assert.equal(final.operationRef, 'TEST-op-1'); assert.equal(final.beforeObserved, true); assert.equal(final.gapReason, undefined)
  assert.equal(final.nativeSessionId, a.host.nativeSessionId); assert.equal(final.nativeInputId, a.host.submittedIds[0])
  assert.deepEqual(final.items.map(item => [item.messageId, item.partId, item.callId]), [[message.info.id, tool.id, tool.callID]])
  assert.deepEqual(final.items[0]!.metadata, metadata); assert(Object.isFrozen(final.items[0]!.metadata))
  assert.equal(a.events.some(value => value.kind === 'result'), false); assert.equal(a.host.submittedIds.length, 1)
  after.release(); assert((await queued).ok)
  assert.equal(final.signal.aborted, true); assert.equal(requests[0]!.signal.aborted, true)
  a.host.complete()
  await until(() => a.events.filter(value => value.kind === 'result').length === 2)
  const second = requests.find(value => value.phase === 'after' && value.inputId === 'TEST-input-2'); assert(second?.phase === 'after')
  assert.notEqual(second.windowRef, final.windowRef); assert.notEqual(second.nativeInputId, final.nativeInputId)
})

test('timed-out before cannot resurrect baseline when late; capture failures never deny prompt', async t => {
  const delayed = gate(); const requests: OpenCodeInputWindowRequest[] = []
  const a = await fixture(t, { observe: async value => { requests.push(value); if (value.phase === 'before') {await delayed.promise}; if (value.phase === 'gap') {throw new Error('gap observer failure')} } }, 200)
  assert((await a.driver.submit(input())).ok)
  const before = requests.find(value => value.phase === 'before')!; assert.equal(before.signal.aborted, true)
  delayed.release(); await until(() => a.events.some(value => value.kind === 'result'))
  const final = requests.find(value => value.phase === 'after'); assert(final?.phase === 'after')
  assert.equal(final.beforeObserved, false); assert.equal(final.gapReason, 'timeout'); assert.equal(final.windowRef, before.windowRef)
  assert(requests.some(value => value.phase === 'gap' && value.reason === 'timeout'))
})

test('close during before sends no prompt even after late completion', async t => {
  const delayed = gate(); const requests: OpenCodeInputWindowRequest[] = []
  const a = await fixture(t, { observe: async value => { requests.push(value); if (value.phase === 'before') {await delayed.promise} } })
  const submission = a.driver.submit(input()); await until(() => requests.length > 0)
  await a.driver.close(); delayed.release()
  assert.deepEqual(await submission, { ok: false, code: 'unknown', delivery: 'known-not-sent' })
  assert.equal(a.host.submittedIds.length, 0); assert.equal(requests[0]!.signal.aborted, true)
  assert.equal(requests.some(value => value.phase === 'after'), false)
})

test('native preflight failure invalidates original window without successful after or retarget', async t => {
  const requests: OpenCodeInputWindowRequest[] = []
  const a = await fixture(t, { observe: value => { requests.push(value); if (value.phase === 'before') {a.host.foreign()} } })
  assert.deepEqual(await a.driver.submit(input()), { ok: false, code: 'dependency-unavailable', delivery: 'known-not-sent' })
  await until(() => requests.some(value => value.phase === 'gap'))
  assert.equal(a.host.submittedIds.length, 0); assert.equal(requests.some(value => value.phase === 'after'), false)
})

test('foreign parent cannot supply final metadata or terminal capture', async t => {
  const requests: OpenCodeInputWindowRequest[] = []
  const a = await fixture(t, { observe: value => { requests.push(value) } }, 200)
  a.host.wrongParent(); assert((await a.driver.submit(input())).ok)
  // Peer fixes parent at complete; replace it after its prompt response before polling settles.
  a.host.messages.at(-1)!.info.parentID = 'msg_foreign'
  await until(() => a.events.some(value => value.kind === 'result'))
  assert.equal(requests.some(value => value.phase === 'after'), false)
  assert(requests.some(value => value.phase === 'gap'))
})

test('before/after/gap failures never deny native work; interrupted terminal keeps original input identity', async t => {
  const requests: OpenCodeInputWindowRequest[] = []
  const a = await fixture(t, { observe: async value => {
    requests.push(value)
    if (value.phase === 'gap') {await Promise.reject(new Error('TEST gap failure'))}
    else if (value.phase === 'before') {throw new Error('TEST baseline failure')}
    else {throw new Error('TEST final failure')}
  } })
  a.host.hold(); assert((await a.driver.submit(input())).ok)
  assert((await a.driver.interrupt('TEST-op-1')).ok)
  await until(() => a.events.some(value => value.kind === 'result'))
  const final = requests.find(value => value.phase === 'after'); assert(final?.phase === 'after')
  assert.equal(final.beforeObserved, false); assert.equal(final.gapReason, 'capture-failed'); assert.equal(final.outcome, 'cancelled')
  assert.equal(final.operationRef, 'TEST-op-1')
  assert(a.events.some(value => value.kind === 'result' && value.outcome === 'cancelled'))
})

test('bounded metadata refuses oversized or malformed observations without fabricating an image or blocking terminal observation', async () => {
  const { OpenCodeInputWindowCapture } = await import('../../../../src/features/provider-session-implementation/adapters/opencode-protocol/input-window-capture.ts')
  const requests: OpenCodeInputWindowRequest[] = []
  const capture = new OpenCodeInputWindowCapture({ identity: { sessionRef: 'TEST', windowRef: 'TEST-window', inputId: 'TEST-input', operationRef: 'TEST-op', nativeSessionId: 'ses_TEST' },
    port: { observe: value => {requests.push(value)} }, abort: new AbortController().signal, timeoutMs: 100, maxItems: 1, maxBytes: 32 })
  await capture.before()
  await capture.after('msg_TEST', 'succeeded', [{ messageId: 'msg_TESTassistant', partId: 'prt_TEST', callId: 'TEST-call', tool: 'edit', status: 'completed',
    input: null, metadata: { filediff: { patch: 'x'.repeat(100) } }, startedAt: 1, completedAt: 2 }])
  const final = requests.find(value => value.phase === 'after'); assert(final?.phase === 'after')
  assert.equal(final.gapReason, 'limit'); assert.deepEqual(final.items, [])
  assert(requests.some(value => value.phase === 'gap' && value.reason === 'limit'))
  for (const field of ['messageId', 'startedAt', 'metadata'] as const) {
    const invalidRequests: OpenCodeInputWindowRequest[] = []
    const invalid = new OpenCodeInputWindowCapture({ identity: { sessionRef: 'TEST', windowRef: `TEST-invalid-${field}`, inputId: 'TEST-input', operationRef: 'TEST-op', nativeSessionId: 'ses_TEST' },
      port: { observe: value => {invalidRequests.push(value)} }, abort: new AbortController().signal, timeoutMs: 100, maxItems: 1, maxBytes: 1024 })
    const item = { messageId: 'msg_TESTassistant', partId: 'prt_TEST', callId: 'TEST-call', tool: 'edit', status: 'completed', input: null, metadata: null, startedAt: 1, completedAt: 2 }
    if (field === 'metadata') {Reflect.deleteProperty(item, field)} else {Reflect.set(item, field, false)}
    await invalid.before()
    await invalid.after('msg_TEST', 'succeeded', [item])
    const invalidFinal = invalidRequests.find(value => value.phase === 'after'); assert(invalidFinal?.phase === 'after')
    assert.equal(invalidFinal.gapReason, 'limit', field); assert.deepEqual(invalidFinal.items, [], field)
    assert(invalidRequests.some(value => value.phase === 'gap' && value.reason === 'limit'), field)
  }
})

test('optional capture getter is read once and an initially absent changing port never bypasses snapshot', async t => {
  const a = await fixture(t, { observe() {} })
  const { snapshotV1Config } = await import('../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v1-driver-config.ts')
  let reads = 0
  Object.defineProperty(a.config, 'capture', { enumerable: true, get() { return ++reads === 1 ? undefined : { observe() {throw new Error('unsnapshotted')} } } })
  const selected = snapshotV1Config(a.config, request)
  assert.equal(reads, 1); assert.equal(Object.hasOwn(selected, 'capture'), false)
})
