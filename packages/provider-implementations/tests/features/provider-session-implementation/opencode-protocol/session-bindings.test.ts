import assert from 'node:assert/strict'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createOpenCodeSessionBindings } from '../../../../src/opencode.ts'
import type { OpenCodeBindingStorage, OpenCodeStoredBinding } from '../../../../src/opencode.ts'

const createdAt = '2026-10-20T00:00:00.000Z'
function record(name: string, session: string) {
  return { teamId: 'TEST-team', laneId: 'primary', memberName: name, providerId: 'opencode',
    runId: 'TEST-run', selectedModel: 'TEST/model', projectPath: '/TEST/workspace',
    profileRootKey: 'TEST-profile', hostKey: 'TEST-host', opencodeSessionId: session,
    resolvedBehaviorFingerprint: null, lastCanonicalCursor: null, lastKnownRawStatus: 'idle',
    lastKnownDurableState: 'idle', sourceAuthFingerprint: null, managedAuthFingerprint: null,
    projectBehaviorFingerprint: 'TEST-behavior', staleReason: null, createdAt, updatedAt: createdAt,
    futureRecordExtension: { preserve: ['exact', 42] } }
}
const binding = (member: string, session: string): OpenCodeStoredBinding => ({
  storageKey: `TEST-team::primary::${member}`, nativeSessionId: session,
  workspacePath: '/TEST/workspace', hostKey: 'TEST-host', runId: 'TEST-run',
  profileRootKey: 'TEST-profile', createdAt,
})
const initial = () => ({ schemaVersion: 1, records: {
  'TEST-team::primary::A': record('A', 'session_A'), 'TEST-team::primary::B': record('B', 'session_B'),
}, futureEnvelope: { retained: true }, stopReceipts: {} })

async function diskFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'TEST-opencode-binding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'session-store.json')
  await writeFile(path, JSON.stringify(initial()))
  let queue = Promise.resolve(), attempts = 0, loseNextReceipt = false
  // The test's one persistence custodian serializes atomic compare-and-replace.
  // Production custody, cross-process locking and crash durability belong to the runtime port.
  const storage: OpenCodeBindingStorage = {
    read: async () => ({ kind: 'known', bytes: await readFile(path, 'utf8') }),
    compareAndSwap: (expected, replacement) => {
      const operation = queue.then(async () => {
        attempts++
        if (await readFile(path, 'utf8') !== expected) {return false}
        await writeFile(path + '.next', replacement)
        await rename(path + '.next', path)
        if (loseNextReceipt) { loseNextReceipt = false; throw new Error('TEST lost receipt after replace') }
        return true
      })
      queue = operation.then(() => { return }, () => { return })
      return operation
    },
  }
  return { storage, path, loseNext: () => { loseNextReceipt = true }, attempts: () => attempts }
}

test('lost cursor write receipt remains unknown; restart observes original binding without replay', async t => {
  const fixture = await diskFixture(t)
  const a = createOpenCodeSessionBindings(fixture.storage, binding('A', 'session_A'))
  fixture.loseNext()
  assert.deepEqual(await a.updateCursor(null, 'native_cursor_1'), { kind: 'unknown' })
  assert.equal(fixture.attempts(), 1)
  const restarted = createOpenCodeSessionBindings(fixture.storage, binding('A', 'session_A'))
  assert.deepEqual(await restarted.observe(), { kind: 'bound', cursor: 'native_cursor_1', stoppedAt: null })
  assert.equal(fixture.attempts(), 1)
  assert.deepEqual(await restarted.updateCursor(null, 'native_cursor_1'), { kind: 'conflict' })
  assert.equal(fixture.attempts(), 1)
  const persisted = JSON.parse(await readFile(fixture.path, 'utf8'))
  assert.deepEqual(persisted.futureEnvelope, { retained: true })
  assert.deepEqual(persisted.records['TEST-team::primary::A'].futureRecordExtension, { preserve: ['exact', 42] })
  assert.deepEqual(persisted.records['TEST-team::primary::B'], record('B', 'session_B'))
})

test('concurrent cursors cannot lose a sibling record update; conflict is explicit', async t => {
  const fixture = await diskFixture(t)
  let readCount = 0, releaseReads!: () => void
  const bothRead = new Promise<void>(resolve => { releaseReads = resolve })
  const concurrentStorage: OpenCodeBindingStorage = { ...fixture.storage, read: async () => {
    const result = await fixture.storage.read()
    if (++readCount === 2) {releaseReads()}
    await bothRead
    return result
  } }
  const a = createOpenCodeSessionBindings(concurrentStorage, binding('A', 'session_A'))
  const b = createOpenCodeSessionBindings(concurrentStorage, binding('B', 'session_B'))
  const results = await Promise.all([a.updateCursor(null, 'cursor_A'), b.updateCursor(null, 'cursor_B')])
  assert.equal(results.filter(value => value.kind === 'updated').length, 1)
  assert.equal(results.filter(value => value.kind === 'conflict').length, 1)
  const persisted = JSON.parse(await readFile(fixture.path, 'utf8'))
  assert.equal(Object.values(persisted.records).filter((value: unknown) =>
    value && typeof value === 'object' && 'lastCanonicalCursor' in value && value.lastCanonicalCursor !== null).length, 1)
  assert.deepEqual(persisted.futureEnvelope, { retained: true })
})

test('workspace, host, run, native generation and stored creation identity cannot be rebound', async t => {
  const fixture = await diskFixture(t)
  for (const changed of [
    { workspacePath: '/TEST/other' }, { hostKey: 'TEST-other-host' }, { runId: 'TEST-next-run' },
    { nativeSessionId: 'session_successor' }, { createdAt: '2026-10-21T00:00:00.000Z' },
    { profileRootKey: 'TEST-other-profile' },
  ]) {
    const adapter = createOpenCodeSessionBindings(fixture.storage, { ...binding('A', 'session_A'), ...changed })
    assert.deepEqual(await adapter.observe(), { kind: 'binding_mismatch' })
    assert.deepEqual(await adapter.updateCursor(null, 'cursor'), { kind: 'binding_mismatch' })
  }
  assert.equal(fixture.attempts(), 0)
})

test('unknown envelopes, archive keys and materialization fences are preserved without writes', async t => {
  const fixture = await diskFixture(t)
  for (const bytes of ['{invalid', JSON.stringify({ ...initial(), schemaVersion: 2 }),
    JSON.stringify({ ...initial(), version: 2 }), JSON.stringify({ ...initial(), generation: 'v2' })]) {
    await writeFile(fixture.path, bytes)
    const adapter = createOpenCodeSessionBindings(fixture.storage, binding('A', 'session_A'))
    assert.deepEqual(await adapter.updateCursor(null, 'cursor'), { kind: 'unknown' })
    assert.equal(await readFile(fixture.path, 'utf8'), bytes)
  }
  const store = { ...initial(), materializationClaims: { 'TEST-team::primary::A': 'pending' } }
  await writeFile(fixture.path, JSON.stringify(store))
  assert.deepEqual(await createOpenCodeSessionBindings(fixture.storage, binding('A', 'session_A')).observe(), { kind: 'fenced' })
  await writeFile(fixture.path, JSON.stringify({ ...initial(), records: { 'TEST-team::A': record('A', 'session_A') } }))
  assert.deepEqual(await createOpenCodeSessionBindings(fixture.storage, binding('A', 'session_A')).observe(), { kind: 'missing' })
  assert.equal(fixture.attempts(), 0)
})

test('owner generation and terminal records fence stale cursor writers', async t => {
  const fixture = await diskFixture(t)
  const owner = { attemptId: 'TEST-attempt', sessionId: 'session_A', version: 2 }
  await writeFile(fixture.path, JSON.stringify({ ...initial(), materializationOwners: { 'TEST-team::primary::A': owner } }))
  const stale = createOpenCodeSessionBindings(fixture.storage, { ...binding('A', 'session_A'), materializationOwner: { ...owner, version: 1 } })
  assert.deepEqual(await stale.updateCursor(null, 'cursor'), { kind: 'fenced' })
  const current = createOpenCodeSessionBindings(fixture.storage, { ...binding('A', 'session_A'), materializationOwner: owner })
  assert.deepEqual(await current.updateCursor(null, 'cursor'), { kind: 'updated' })
  const stopped = initial()
  Object.assign(stopped.records['TEST-team::primary::A'], { stoppedAt: createdAt })
  await writeFile(fixture.path, JSON.stringify(stopped))
  assert.deepEqual(await createOpenCodeSessionBindings(fixture.storage, binding('A', 'session_A')).updateCursor(null, 'later'), { kind: 'fenced' })
  assert.equal(fixture.attempts(), 1)
})

test('opaque numeric data that would round during JSON rewrite is preserved without CAS', async t => {
  const fixture = await diskFixture(t)
  for (const numericSource of ['9007199254740993', '0.10000000000000001', '-0', '1e309']) {
    for (const bytes of [
      JSON.stringify(initial()).replace('"futureEnvelope":{"retained":true}',
        `"futureEnvelope":{"retained":true,"opaqueNumber":${numericSource}}`),
      JSON.stringify(initial()).replace('"TEST-team::primary::B":{',
        `"TEST-team::primary::B":{"opaqueSiblingNumber":${numericSource},`),
    ]) {
      await writeFile(fixture.path, bytes)
      const adapter = createOpenCodeSessionBindings(fixture.storage, binding('A', 'session_A'))
      assert.deepEqual(await adapter.updateCursor(null, 'cursor'), { kind: 'unknown' })
      assert.equal(await readFile(fixture.path, 'utf8'), bytes)
    }
  }
  assert.equal(fixture.attempts(), 0)
})

test('cursor growth cannot exceed input or rewritten store byte budgets', async t => {
  const fixture = await diskFixture(t)
  const adapter = createOpenCodeSessionBindings(fixture.storage, binding('A', 'session_A'))
  const before = await readFile(fixture.path, 'utf8')
  assert.deepEqual(await adapter.updateCursor(null, 'x'.repeat(64 * 1024 + 1)), { kind: 'unknown' })
  assert.equal(await readFile(fixture.path, 'utf8'), before)
  const envelope = initial()
  // Canonical bytes fit the read bound but adding an escaped cursor exceeds it.
  const base = JSON.stringify(envelope)
  const nearLimit = base.replace('"futureEnvelope":{"retained":true}',
    '"futureEnvelope":{"retained":true,"padding":"' + 'x'.repeat(32 * 1024 * 1024 - Buffer.byteLength(base) - 20) + '"}')
  assert(Buffer.byteLength(nearLimit) < 32 * 1024 * 1024)
  await writeFile(fixture.path, nearLimit)
  assert.deepEqual(await adapter.updateCursor(null, '\\'.repeat(64 * 1024)), { kind: 'unknown' })
  assert.equal(await readFile(fixture.path, 'utf8'), nearLimit)
  assert.equal(fixture.attempts(), 0)
})
