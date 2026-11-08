import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { parse, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { createOpenCodeV2ExecutionTransport, readOpenCodeV2NativeCut, projectOpenCodeV2NativeTurn } from '../../../../src/opencode.ts'
import { cut, sessionID, nativeInputID } from './v2-cut-fixture.ts'

async function fixture(mode: 'stable' | 'changing' | 'cycle' | 'foreign' | 'max' | 'overmax' | 'flat' |
  'gapped' | 'backwards' | 'stale-sync' | 'empty-owned-sync' | 'malformed-session' | 'malformed-message') {
  const value = cut(), directory = resolve('TEST/native-cut')
  let logs = 0, pages = 0, requests = 0
  const server = createServer((req, res) => {
    requests++; assert.equal(req.method, 'GET')
    const url = new URL(req.url!, 'http://TEST.invalid')
    if (url.pathname.endsWith('/log')) {
      logs++
      const rows = value.log.events.map(row => ({ id: row.id, type: row.type,
        durable: { aggregateID: row.aggregateID, seq: row.seq }, data: row.data, location: { directory } }))
      if (mode === 'changing' && logs === 2) {rows.push({ id: 'evt_changed', type: 'session.updated',
        durable: { aggregateID: sessionID, seq: 10 }, data: { sessionID }, location: { directory } })}
      // Both pinned V2 versions filter the shared durable bus: session log seq may gap.
      if (mode === 'gapped') for (const [i, row] of rows.entries()) {
        if (i >= 4) row.durable.seq += 2
      }
      if (mode === 'backwards') rows[5]!.durable.seq = rows[4]!.durable.seq
      if (mode === 'max' || mode === 'overmax') {
        const count = mode === 'max' ? 4096 : 4097
        while (rows.length < count) { const seq = rows.length; rows.push({ id: `evt_max${seq}`, type: 'session.updated',
          durable: { aggregateID: sessionID, seq }, data: { sessionID }, location: { directory } }) }
      }
      if (mode === 'empty-owned-sync') rows.length = 0
      const watermark = mode === 'empty-owned-sync' ? 0
        : rows.at(-1)!.durable.seq + (mode === 'gapped' ? 2 : mode === 'stale-sync' ? -1 : 0)
      res.setHeader('content-type', 'text/event-stream')
      res.end([...rows, { type: 'log.synced', aggregateID: sessionID, seq: watermark }]
        .map(row => `data: ${JSON.stringify(row)}\n\n`).join(''))
      return
    }
    res.setHeader('content-type', 'application/json')
    if (url.pathname.endsWith('/message')) {
      pages++
      if (mode === 'malformed-message') {
        res.end('{"data":TEST_PRIVATE_NATIVE_JSON_PAYLOAD}')
        return
      }
      if (!url.searchParams.has('cursor')) {
        const data = value.messages.data.map(row => ({ ...row.data, id: row.id, type: row.type,
          time: { ...(row.data.time as object | undefined), created: row.timeCreated } }))
        res.end(JSON.stringify({ data, cursor: { previous: 'start', next: 'end' } }))
      } else if (mode === 'cycle') {
        res.end(JSON.stringify({ data: [{ id: 'msg_cycle', type: 'user', time: { created: 11 }, text: 'TEST' }],
          cursor: { previous: 'start', next: 'end' } }))
      } else {res.end(JSON.stringify({ data: [], cursor: { previous: null, next: null } }))}
      return
    }
    const session = { id: sessionID, location: { directory: mode === 'foreign' ? '/TEST/foreign' : directory },
      agent: 'TEST-agent', model: { providerID: 'TEST-provider', id: 'TEST-model' }, time: { created: 1 } }
    res.end(mode === 'malformed-session' ? '{"data":TEST_PRIVATE_NATIVE_JSON_PAYLOAD}' :
      JSON.stringify(mode === 'flat' ? session : { data: session }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert(address && typeof address !== 'string')
  return { endpoint: `http://127.0.0.1:${address.port}`, directory,
    counts: () => ({ logs, pages, requests }),
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) }) },
  }
}

test('actual finite HTTP transport reads one stable native cut and projects provider facts', async t => {
  const host = await fixture('stable'); t.after(host.close)
  const transport = createOpenCodeV2ExecutionTransport({ endpoint: host.endpoint, directory: host.directory,
    nativeSessionId: sessionID,
    version: '2.0.21', deadline: Date.now() + 10_000, readPassword: () => 'TEST-private' })
  t.after(() => transport.dispose())
  const snapshot = await readOpenCodeV2NativeCut(transport,
    { endpoint: host.endpoint, directory: host.directory, sessionID, pin: '2.0.21' },
    { nativeInputID, beforeCursor: 0, text: 'TEST input' })
  const outcome = projectOpenCodeV2NativeTurn(snapshot)
  assert.equal(outcome.state, 'succeeded')
  assert.equal(outcome.text, 'TEST reply')
  assert.equal(outcome.tools.length, 1)
  assert.equal('visibleReplies' in outcome, false)
  assert.deepEqual(host.counts(), { logs: 2, pages: 2, requests: 6 })
})

test('native cut read rejects changing history, pagination cycles and original workspace mismatch', async t => {
  for (const mode of ['changing', 'cycle', 'foreign', 'flat'] as const) {
    const host = await fixture(mode); t.after(host.close)
    const transport = createOpenCodeV2ExecutionTransport({ endpoint: host.endpoint, directory: host.directory,
    nativeSessionId: sessionID,
      version: '2.0.21', deadline: Date.now() + 10_000, readPassword: () => 'TEST-private' })
    t.after(() => transport.dispose())
    await assert.rejects(readOpenCodeV2NativeCut(transport,
      { endpoint: host.endpoint, directory: host.directory, sessionID, pin: '2.0.21' },
      { nativeInputID, beforeCursor: 0, text: 'TEST input' }),
    mode === 'changing' ? /mutable_native_readback/ : mode === 'cycle' ? /incomplete_native_transcript/ : mode === 'flat' ? /invalid_native_envelope/ : /binding_mismatch/)
    if (mode === 'cycle') {assert.equal(host.counts().pages, 2)}
    if (mode === 'foreign' || mode === 'flat') {assert.deepEqual(host.counts(), { logs: 0, pages: 0, requests: 1 })}
  }
})


test('pinned native durable log accepts filtered bus gaps but rejects non-monotonic events and stale sync', async t => {
  for (const mode of ['gapped', 'backwards', 'stale-sync'] as const) {
    const host = await fixture(mode); t.after(host.close)
    const transport = createOpenCodeV2ExecutionTransport({ endpoint: host.endpoint, directory: host.directory,
    nativeSessionId: sessionID,
      version: '2.0.21', deadline: Date.now() + 10_000, readPassword: () => 'TEST-private' })
    t.after(() => transport.dispose())
    const work = readOpenCodeV2NativeCut(transport,
      { endpoint: host.endpoint, directory: host.directory, sessionID, pin: '2.0.21' },
      { nativeInputID, beforeCursor: 0, text: 'TEST input' })
    if (mode === 'gapped') {
      const snapshot = await work
      assert.equal(snapshot.log.events[4]?.seq, 6)
      assert.equal(snapshot.log.events.at(-1)?.seq, 11)
      assert.equal(snapshot.log.watermark, 13)
      assert.equal(projectOpenCodeV2NativeTurn(snapshot).state, 'succeeded')
    } else { await assert.rejects(work, /incomplete_native_log/) }
  }
})

test('real pre-execution V2 log with owned sync only never qualifies a successful turn', async t => {
  const host = await fixture('empty-owned-sync'); t.after(host.close)
  const transport = createOpenCodeV2ExecutionTransport({ endpoint: host.endpoint, directory: host.directory,
    nativeSessionId: sessionID,
    version: '2.0.21', deadline: Date.now() + 10_000, readPassword: () => 'TEST-private' })
  t.after(() => transport.dispose())
  const snapshot = await readOpenCodeV2NativeCut(transport,
    { endpoint: host.endpoint, directory: host.directory, sessionID, pin: '2.0.21' },
    { nativeInputID, beforeCursor: 0, text: 'TEST input' })
  assert.deepEqual(snapshot.log, { events: [], synced: true, watermark: 0 })
  const result = projectOpenCodeV2NativeTurn(snapshot)
  assert.equal(result.state, 'unknown')
  assert.equal(result.reason, 'missing_native_log_prefix')
  assert.deepEqual(result.tools, [])
})

test('native finite cut accepts 4096 events plus synced frame and rejects a 4097th event', async t => {
  for (const mode of ['max', 'overmax'] as const) {
    const host = await fixture(mode); t.after(host.close)
    const transport = createOpenCodeV2ExecutionTransport({ endpoint: host.endpoint, directory: host.directory,
    nativeSessionId: sessionID,
      version: '2.0.21', deadline: Date.now() + 10_000, readPassword: () => 'TEST-private' })
    t.after(() => transport.dispose())
    const work = readOpenCodeV2NativeCut(transport,
      { endpoint: host.endpoint, directory: host.directory, sessionID, pin: '2.0.21' },
      { nativeInputID, beforeCursor: 0, text: 'TEST input' })
    if (mode === 'max') {
      const value = await work
      assert.equal(value.log.events.length, 4096)
      assert.equal(projectOpenCodeV2NativeTurn(value).state, 'succeeded')
    } else {await assert.rejects(work, /frame_limit/)}
  }
})

test('malformed session and message JSON fail closed without leaking native body or skipping read budgets', async t => {
  for (const mode of ['malformed-session', 'malformed-message'] as const) {
    const host = await fixture(mode); t.after(host.close)
    const transport = createOpenCodeV2ExecutionTransport({ endpoint: host.endpoint, directory: host.directory,
      nativeSessionId: sessionID, version: '2.0.21', deadline: Date.now() + 10_000,
      readPassword: () => 'TEST-private' })
    t.after(() => transport.dispose())
    await assert.rejects(readOpenCodeV2NativeCut(transport,
      { endpoint: host.endpoint, directory: host.directory, sessionID, pin: '2.0.21' },
      { nativeInputID, beforeCursor: 0, text: 'TEST input' }),
    (error: unknown) => error instanceof Error && error.message === 'invalid_native_read_json')
    assert.deepEqual(host.counts(), mode === 'malformed-session'
      ? { logs: 0, pages: 0, requests: 1 }
      : { logs: 1, pages: 1, requests: 3 })
  }
})

test('direct read-cut rejects malformed binding before any native fetch', async () => {
  // Unlike DriverConfig, this public read-only cut accepts an injected
  // transport. Invalid serialized profile data must not reach that transport.
  for (const pin of ['2.0.0', '2.0.21'] as const) {
    const directory = resolve('TEST/native-cut')
    const valid = { endpoint: 'http://127.0.0.1:12345', directory, sessionID, pin }
    const malformed: readonly Record<string, unknown>[] = [
      { endpoint: ['http://127.0.0.1:12345'] },
      { endpoint: 'http://127.0.0.1:65536' },
      { endpoint: 'http://127.0.0.1:12345678901234567890' },
      { endpoint: 'http://127.0.0.1:00080' },
      { endpoint: 12345 },
      { directory: ['/TEST/native-cut'] },
      { directory: 42 },
      { directory: 'x'.repeat(8193) },
      { directory: parse(directory).root },
      { directory: directory + sep },
      { directory: directory + sep + '..' + sep + 'TEST-foreign' },
      { directory: directory + sep + sep + 'TEST-neighbor' },
      { directory: directory + '\0invalid' },
    ]
    for (const overrides of malformed) {
      let requests = 0
      const transport = {
        check() { throw new Error('transport_should_not_be_checked') },
        async fetch(_request: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
          requests++
          throw new Error('native_fetch_must_not_run')
        },
      }
      await assert.rejects(readOpenCodeV2NativeCut(transport,
        { ...valid, ...overrides } as unknown as Parameters<typeof readOpenCodeV2NativeCut>[1],
        { nativeInputID, beforeCursor: 0, text: 'TEST input' }),
      /invalid_native_read_binding/)
      assert.equal(requests, 0)
    }
  }
})
