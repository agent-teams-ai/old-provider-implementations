import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { DriverFactory, Event, OpenConfig, Session } from '@agent-teams/provider-session-contracts'
import { createOpenCodeV1DriverFactory, readOpenCodeV1CheckpointSessionId } from '../../../../src/opencode.ts'
import type { OpenCodeV1DriverConfig } from '../../../../src/opencode.ts'
import { v1Peer } from './v1-driver-peer.ts'
import { artifact, attachedInput, attachmentPort } from '../provider-session-io/attachment-support.ts'
const request: OpenConfig = { tenantId: 'TEST-tenant', projectId: 'TEST-project', sessionId: 'TEST-session', generation: 1, configRevision: 'TEST-r1', requiredCapabilities: ['text'] }
function configuration(host: Awaited<ReturnType<typeof v1Peer>>): OpenCodeV1DriverConfig {
  return { endpoint: host.endpoint, workspacePath: host.directory, nativeSessionId: host.nativeSessionId, version: '1.18.34',
    binding: { tenantId: request.tenantId, projectId: request.projectId, sessionId: request.sessionId, generation: request.generation }, configRevision: request.configRevision,
    trustedBinding: 'TEST-host', accountBinding: 'TEST-account', profileBinding: 'TEST-profile', runBinding: 'TEST-run', model: { providerID: 'TEST-provider', modelID: 'TEST-model' },
    limits: { queuedInputs: 2, inputBytes: 4096, outputEvents: 100, outputBytes: 100_000, pendingInteractions: 2, timeoutMs: 3000 }, probe: async () => true, confirmStopped: async () => true }
}
function factory(c: OpenCodeV1DriverConfig, cp?: () => unknown): DriverFactory {
  return createOpenCodeV1DriverFactory({ capabilities: ['text', 'tools', 'permission', 'interrupt', 'checkpoint'], resolveConfiguration: async () => c, readCheckpoint: async () => cp?.() })
}
async function until(predicate: () => boolean) { const deadline = Date.now() + 4000; while (!predicate()) { if (Date.now() > deadline) {assert.fail('TEST observation deadline');} await delay(10) } }
function observe(session: Session) { const events: Event[] = []; const done = (async () => { for await (const event of session.observe()) {events.push(event)} })(); return { events, done } }

test('selected V1 prompt_async serializes actual ordered native file parts for images and approved video', async t => {
  const host = await v1Peer(); t.after(host.close)
  const c = configuration(host); c.version = '1.18.35'; c.model = { providerID: 'minimax-coding-plan', modelID: 'minimax-m3' }
  const items = [artifact('TEST-video', 'video/mp4'), artifact('TEST-image', 'image/png')]
  c.attachments = attachmentPort('minimax-coding-plan/minimax-m3', items)
  const { driver } = await factory(c).open(request)
  try {
    const refs = items.map(item => ({ ...item.reference })); const submission = driver.submit(attachedInput(refs)); refs.reverse()
    assert.equal((await submission).ok, true)
    assert.deepEqual(host.submittedParts[0], [{ type: 'text', text: 'TEST text' }, ...items.map(item => ({ type: 'file', mime: item.reference.mimeType,
      url: 'data:' + item.reference.mimeType + ';base64,' + item.bytes.toString('base64'), filename: item.reference.artifactId }))])
  } finally { await driver.close() }
})

test('V1 unsupported model projection and missing artifact cannot reach native prompt_async', async t => {
  const host = await v1Peer(); t.after(host.close); const c = configuration(host), image = artifact(), port = attachmentPort('different-model', [image])
  c.attachments = port
  const { driver } = await factory(c).open(request)
  try {
    assert.deepEqual(await driver.submit(attachedInput([image.reference])), { ok: false, code: 'unsupported', delivery: 'known-not-sent' })
    assert.equal(host.submittedIds.length, 0)
  } finally { await driver.close() }
  c.attachments = { ...port, model: 'TEST-provider/TEST-model', resolve: attachmentPort('TEST-provider/TEST-model', []).resolve }
  const next = (await factory(c).open(request)).driver
  try {
    assert.deepEqual(await next.submit(attachedInput([image.reference])), { ok: false, code: 'dependency-unavailable', delivery: 'known-not-sent' })
    assert.equal(host.submittedIds.length, 0)
  } finally { await next.close() }
})

test('canonical V1 factory serializes actual HTTP turns with native ascending IDs and exact text/tool ownership', async t => {
  const host = await v1Peer(); t.after(host.close)
  const opened = await factory(configuration(host)).open(request), { events, done } = observe(opened.driver)
  try {
    const a = opened.driver.submit({ inputId: 'TEST-a', operationRef: 'TEST-op-a', content: 'TEST first' })
    const b = opened.driver.submit({ inputId: 'TEST-b', operationRef: 'TEST-op-b', content: 'TEST second' })
    assert.deepEqual(await a, { ok: true, value: { inputId: 'TEST-a', operationRef: 'TEST-op-a', delivery: 'client-consumed', providerAcceptance: 'unknown' } })
    assert.equal((await b).ok, true)
    await until(() => events.filter(event => event.kind === 'result').length === 2)
    assert.deepEqual(events.filter(event => event.kind === 'result').map(event => [event.inputId, event.outcome]), [['TEST-a', 'succeeded'], ['TEST-b', 'succeeded']])
    assert.ok(host.submittedIds[1]! > host.submittedIds[0]!)
    assert.ok(events.some(event => event.kind === 'tool-result' && event.inputId === 'TEST-a'))
    assert.equal(opened.driver.checkpoint().ok, true)
  } finally { await opened.driver.close(); await done }
})

test('V1 omitted idle status with a busy neighbor qualifies only exact settled turns and admits the next input', async t => {
  const host = await v1Peer(); t.after(host.close)
  const c = configuration(host); c.version = '1.18.35'; c.limits = { ...c.limits, timeoutMs: 500 }
  const { driver } = await factory(c).open(request), { events, done } = observe(driver)
  try {
    for (const inputId of ['TEST-native-idle-a', 'TEST-native-idle-b']) {
      assert.equal((await driver.submit({ inputId, operationRef: inputId, content: 'TEST native idle omission' })).ok, true)
      await until(() => events.some(event => event.kind === 'result' && event.inputId === inputId))
      const result = events.find(event => event.kind === 'result' && event.inputId === inputId)
      assert.ok(result?.kind === 'result'); assert.equal(result.outcome, 'succeeded')
    }
    assert.equal(host.submittedIds.length, 2)
  } finally { await driver.close(); await done }
})

test('V1 malformed, unknown or busy status cannot qualify a settled native transcript', async t => {
  const host = await v1Peer(); host.hold(); t.after(host.close)
  const c = configuration(host); c.limits = { ...c.limits, timeoutMs: 10_000 }
  const { driver } = await factory(c).open(request), { events, done } = observe(driver)
  try {
    await driver.submit({ inputId: 'TEST-status', operationRef: 'TEST-status', content: 'TEST status guards' })
    // Empty status cannot replace incomplete native assistant/tool evidence.
    host.status({}); let reads = host.reads(); await until(() => host.reads() >= reads + 4)
    assert.equal(events.some(event => event.kind === 'result'), false)
    host.complete()
    for (const status of [null, [], 'idle', { ses_TESTneighbor: null }, ...[null, {}, 'unknown',
      { type: 'unknown' }, { type: 'idle', status: 'busy' }, { type: 'busy' }, { type: 'retry' }].map(value => ({ [host.nativeSessionId]: value }))]) {
      host.status(status); reads = host.reads(); await until(() => host.reads() >= reads + 4)
      assert.equal(events.some(event => event.kind === 'result'), false)
    }
    host.status({}); await until(() => events.some(event => event.kind === 'result' && event.outcome === 'succeeded'))
  } finally { await driver.close(); await done }
})

test('V1 native ToolStateError preserves its error text without an output field', async t => {
  const host = await v1Peer(); host.hold(); t.after(host.close)
  const { driver } = await factory(configuration(host)).open(request), { events, done } = observe(driver)
  try {
    assert.equal((await driver.submit({ inputId: 'TEST-error', operationRef: 'TEST-op-error', content: 'TEST failed tool' })).ok, true)
    host.failTool()
    await until(() => events.some(event => event.kind === 'result'))
    const result = events.find(event => event.kind === 'tool-result')
    assert.ok(result?.kind === 'tool-result')
    assert.equal(result.inputId, 'TEST-error'); assert.equal(result.isError, true); assert.equal(result.content, 'TEST failed')
  } finally { await driver.close(); await done }
})

test('V1 unknown prompt response is not replayed and queued neighbor remains known not sent', async t => {
  const host = await v1Peer(); host.loseReceipt(); t.after(host.close)
  const { driver } = await factory(configuration(host)).open(request), { events, done } = observe(driver)
  try {
    const a = driver.submit({ inputId: 'TEST-a', operationRef: 'TEST-op-a', content: 'TEST first' })
    const b = driver.submit({ inputId: 'TEST-b', operationRef: 'TEST-op-b', content: 'TEST second' })
    assert.deepEqual(await a, { ok: false, code: 'unknown' })
    assert.deepEqual(await b, { ok: false, code: 'unknown', delivery: 'known-not-sent' }); await done
    assert.equal(host.submittedIds.length, 1); assert.equal(events.filter(event => event.kind === 'result').length, 1)
  } finally { await driver.close() }
})

test('V1 permission uses exact original assistant/tool lineage and scoped native decision', async t => {
  const host = await v1Peer(); host.permission(); t.after(host.close)
  const { driver } = await factory(configuration(host)).open(request), { events, done } = observe(driver)
  try {
    assert.equal((await driver.submit({ inputId: 'TEST-a', operationRef: 'TEST-op', content: 'TEST permission' })).ok, true)
    await until(() => events.some(event => event.kind === 'interaction'))
    const interaction = events.find(event => event.kind === 'interaction'); assert.ok(interaction?.kind === 'interaction')
    assert.deepEqual(await driver.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: true, value: undefined })
    await until(() => events.some(event => event.kind === 'result' && event.outcome === 'succeeded'))
    assert.equal(host.granted.length, 1)
    assert.deepEqual(await driver.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: false, code: 'stale' })
  } finally { await driver.close(); await done }
})

test('V1 held permission list across interrupt ACK cannot regain authority; valid next turn still works', async t => {
  const host = await v1Peer(); host.permission(); host.abortAckOnly(); host.holdPermission(); t.after(host.close)
  const { driver } = await factory(configuration(host)).open(request), { events, done } = observe(driver)
  try {
    assert.equal((await driver.submit({ inputId: 'TEST-a', operationRef: 'TEST-op', content: 'TEST permission' })).ok, true)
    await until(() => host.permissionReads() === 1)
    assert.deepEqual(await driver.interrupt('TEST-op'), { ok: true, value: { requested: true, terminal: 'unconfirmed' } })
    const reads = host.reads(); host.releasePermission()
    await until(() => host.reads() > reads)
    assert.equal(events.some(event => event.kind === 'interaction'), false)
    assert.deepEqual(await driver.respondToInteraction(host.submittedIds[0] + ':request_TEST', { kind: 'permission', decision: 'allow' }), { ok: false, code: 'stale' })
    assert.equal(host.granted.length, 0)
    host.complete(); await until(() => events.some(event => event.kind === 'result' && event.inputId === 'TEST-a'))
    assert.equal((await driver.submit({ inputId: 'TEST-b', operationRef: 'TEST-op-b', content: 'TEST next' })).ok, true)
    await until(() => events.some(event => event.kind === 'interaction' && event.inputId === 'TEST-b'))
    const next = events.find(event => event.kind === 'interaction' && event.inputId === 'TEST-b'); assert.ok(next?.kind === 'interaction')
    assert.deepEqual(await driver.respondToInteraction(next.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: true, value: undefined })
    await until(() => events.some(event => event.kind === 'result' && event.inputId === 'TEST-b'))
    assert.equal(host.granted.length, 1)
  } finally { host.releasePermission(); await driver.close(); await done }
})

test('V1 exact MessageAbortedError terminal follows observed native evidence, and control ACK fences B', async t => {
  const host = await v1Peer(); host.hold(); host.holdAbort(); t.after(host.close)
  const { driver } = await factory(configuration(host)).open(request), { events, done } = observe(driver)
  try {
    await driver.submit({ inputId: 'TEST-a', operationRef: 'TEST-op', content: 'TEST first' })
    const next = driver.submit({ inputId: 'TEST-b', operationRef: 'TEST-op-b', content: 'TEST next' })
    const cancel = driver.interrupt('TEST-op')
    await until(() => events.some(event => event.kind === 'result' && event.inputId === 'TEST-a' && event.outcome === 'cancelled'))
    assert.equal(host.submittedIds.length, 1)
    host.releaseAbort(); assert.deepEqual(await cancel, { ok: true, value: { requested: true, terminal: 'unconfirmed' } })
    assert.equal((await next).ok, true)
    assert.deepEqual(host.aborted, [host.nativeSessionId])
    assert.deepEqual(await driver.interrupt('TEST-op'), { ok: false, code: 'stale' })
    host.complete(); await until(() => events.some(event => event.kind === 'result' && event.inputId === 'TEST-b'))
  } finally { host.releaseAbort(); await driver.close(); await done }
})

test('V1 terminal revokes a reply preflight before a late grant POST', async t => {
  const host = await v1Peer(); host.permission(); t.after(host.close)
  const { driver } = await factory(configuration(host)).open(request), { events, done } = observe(driver)
  try {
    await driver.submit({ inputId: 'TEST-a', operationRef: 'TEST-op', content: 'TEST first' })
    await until(() => events.some(event => event.kind === 'interaction'))
    const interaction = events.find(event => event.kind === 'interaction'); assert.ok(interaction?.kind === 'interaction')
    const reads = host.permissionReads(); host.holdPermission()
    const reply = driver.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: 'allow' })
    await until(() => host.permissionReads() > reads)
    host.complete(); await until(() => events.some(event => event.kind === 'result'))
    host.releasePermission(); assert.deepEqual(await reply, { ok: false, code: 'stale' }); assert.equal(host.granted.length, 0)
  } finally { host.releasePermission(); await driver.close(); await done }
})

test('V1 conflicting assistant parent cannot emit or grant permission; repaired next turn works', async t => {
  const host = await v1Peer(); host.permission(); host.wrongParent(); t.after(host.close)
  const { driver } = await factory(configuration(host)).open(request), { events, done } = observe(driver)
  try {
    await driver.submit({ inputId: 'TEST-a', operationRef: 'TEST-op', content: 'TEST first' })
    await until(() => host.reads() >= 5)
    assert.equal(events.some(event => event.kind === 'interaction'), false); assert.equal(host.granted.length, 0)
    host.validParent(); host.complete(); await until(() => events.some(event => event.kind === 'result'))
    await driver.submit({ inputId: 'TEST-b', operationRef: 'TEST-op-b', content: 'TEST next' })
    await until(() => events.some(event => event.kind === 'interaction' && event.inputId === 'TEST-b'))
    const interaction = events.find(event => event.kind === 'interaction' && event.inputId === 'TEST-b'); assert.ok(interaction?.kind === 'interaction')
    assert.equal((await driver.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: 'allow' })).ok, true)
  } finally { await driver.close(); await done }
})

test('V1 factory refuses unsupported capability/config generation and restores only selected compatible checkpoint', async t => {
  const host = await v1Peer(); t.after(host.close)
  const c = configuration(host); let checkpoint: unknown, resolved = 0
  const f: DriverFactory = createOpenCodeV1DriverFactory({ capabilities: ['text', 'checkpoint'], resolveConfiguration: async () => { resolved++; return c }, readCheckpoint: async () => checkpoint })
  await assert.rejects(f.open({ ...request, requiredCapabilities: ['question'] }), /unsupported/); assert.equal(resolved, 0)
  await assert.rejects(f.open({ ...request, generation: 2 }), /invalid-config/)
  await assert.rejects(f.open({ ...request, checkpointRef: 'TEST-missing' }), /checkpoint-missing/)
  const first = await f.open(request), cp = first.driver.checkpoint(); assert.ok(cp.ok); checkpoint = cp.value; await first.driver.close()
  c.binding = { ...c.binding, generation: 2 }
  const restored = await f.open({ ...request, generation: 2, checkpointRef: 'TEST-saved' }); await restored.driver.close()
  c.profileBinding = 'TEST-other-profile'
  await assert.rejects(f.open({ ...request, generation: 2, checkpointRef: 'TEST-saved' }), /checkpoint-incompatible/)
  assert.equal(host.submittedIds.length, 0)
})

test('V1 foreign workspace is fenced before native prompt dispatch', async t => {
  const host = await v1Peer(); host.foreign(); t.after(host.close)
  const { driver } = await factory(configuration(host)).open(request)
  try {
    assert.deepEqual(await driver.submit({ inputId: 'TEST-a', operationRef: 'TEST-op', content: 'TEST first' }), { ok: false, code: 'dependency-unavailable', delivery: 'known-not-sent' })
    assert.equal(host.submittedIds.length, 0)
  } finally { await driver.close() }
})

test('V1 tool completion and an unqualified native finish cannot become turn completion', async t => {
  const host = await v1Peer(); host.hold(); t.after(host.close)
  const { driver } = await factory(configuration(host)).open(request), { events, done } = observe(driver)
  try {
    await driver.submit({ inputId: 'TEST-a', operationRef: 'TEST-op', content: 'TEST first' })
    host.toolCompletedOnly(); const before = host.reads()
    await until(() => host.reads() >= before + 4)
    assert.equal(events.some(event => event.kind === 'result'), false)
    assert.ok(events.some(event => event.kind === 'tool-result'))
    host.unqualifiedFinish(); const progress = host.reads()
    await until(() => host.reads() >= progress + 4)
    assert.equal(events.some(event => event.kind === 'result'), false)
    const last = host.messages.at(-1)!; last.info.finish = 'stop'
    await until(() => events.some(event => event.kind === 'result' && event.outcome === 'succeeded'))
  } finally { await driver.close(); await done }
})

test('V1 output bound reserves qualified terminal and honest Host evidence controls cleanup', async t => {
  const host = await v1Peer(); t.after(host.close)
  const c = configuration(host); c.limits = { ...c.limits, outputEvents: 1 }; c.confirmStopped = async () => false
  const { driver } = await factory(c).open(request)
  await driver.submit({ inputId: 'TEST-a', operationRef: 'TEST-op', content: 'TEST first' })
  const events: Event[] = []; for await (const event of driver.observe()) {events.push(event)}
  const result = events.find(event => event.kind === 'result'); assert.ok(result?.kind === 'result')
  assert.equal(result.outcome, 'succeeded'); assert.equal(result.code, 'output-limit')
  assert.deepEqual(await driver.close(), { logicallyClosed: true, cleanup: 'unknown' })
})

test('V1 long retained history and legacy random IDs do not force a full-session scan before new input', async t => {
  const host = await v1Peer(); t.after(host.close)
  for (let index = 0; index < 220; index++) {
    const id = 'msg_0' + ((1n << 124n) - 1n - BigInt(index)).toString(16).padStart(31, '0')
    host.messages.push({ info: { id, sessionID: host.nativeSessionId, role: 'user', time: { created: 0 } },
      parts: [{ id: 'prt_legacy' + index, type: 'text', sessionID: host.nativeSessionId, messageID: id, text: 'TEST retained history' }] })
  }
  const { driver } = await factory(configuration(host)).open(request), { events, done } = observe(driver)
  try {
    assert.equal((await driver.submit({ inputId: 'TEST-a', operationRef: 'TEST-op', content: 'TEST new input' })).ok, true)
    await until(() => events.some(event => event.kind === 'result' && event.outcome === 'succeeded'))
    assert.equal(host.submittedIds.length, 1)
    assert.equal(host.reads(), 3) // latest50 ordering, original anchor window, confirmation
  } finally { await driver.close(); await done }
})


test('V1 private checkpoint identity selection rejects foreign/credential-bearing values before Host allocation', () => {
  const cp = { version: 1, engine: 'opencode-v1', nativeSessionId: 'ses_TESTsaved', compatibility: 'a'.repeat(64) }
  assert.equal(readOpenCodeV1CheckpointSessionId(cp), 'ses_TESTsaved')
  for (const value of [undefined, null, [], { ...cp, engine: 'other' }, { ...cp, nativeSessionId: '../foreign' },
    { ...cp, compatibility: 'not-a-digest' }, { ...cp, apiKey: 'TEST-secret' }]) {
    assert.throws(() => readOpenCodeV1CheckpointSessionId(value), /checkpoint-incompatible/u)
  }
})
