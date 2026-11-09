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
    // Exercise the public injected read transport directly: the standard
    // execution wire rejects malformed JSON earlier with its own fixed failure.
    const transport = { check() {}, fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) }
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

test('direct native read cut refuses empty or whitespace original input before transport access', async () => {
  const directory = resolve('TEST/native-cut')
  for (const text of ['', ' \t\n ']) {
    let checks = 0, fetches = 0
    const transport = {
      check() { checks++ },
      async fetch(): Promise<Response> {
        fetches++
        throw new Error('TEST_transport_must_not_be_called')
      },
    }
    await assert.rejects(readOpenCodeV2NativeCut(transport,
      { endpoint: 'http://127.0.0.1:12345', directory, sessionID, pin: '2.0.21' },
      { nativeInputID, beforeCursor: 0, text }),
    /invalid_native_read_binding/)
    assert.equal(checks, 0)
    assert.equal(fetches, 0)
  }
})

test('direct native read-cut redacts injected fetch and body stream diagnostics', async () => {
  const directory = resolve('TEST/native-cut')
  for (const failure of ['fetch', 'stream'] as const) {
    let requests = 0
    const transport = {
      check() {},
      async fetch(): Promise<Response> {
        requests++
        if (failure === 'fetch') throw new Error('TEST_PRIVATE_NATIVE_FETCH_SECRET')
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.error(new Error('TEST_PRIVATE_NATIVE_STREAM_SECRET')) },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    }
    await assert.rejects(readOpenCodeV2NativeCut(transport,
      { endpoint: 'http://127.0.0.1:12345', directory, sessionID, pin: '2.0.21' },
      { nativeInputID, beforeCursor: 0, text: 'TEST input' }),
    (error: unknown) => error instanceof Error && (
      failure === 'fetch' ? error.message === 'invalid_native_read_response'
        : ['invalid_native_read_response', 'native_read_cleanup_unknown'].includes(error.message)))
    assert.equal(requests, 1)
  }
})

test('public read cut refuses a non-byte stream chunk before reading more data', async () => {
  const directory = resolve('TEST/native-cut')
  let reads = 0, cancelled = 0
  const reader = {
    read() {
      reads++
      if (reads === 1) return Promise.resolve({ done: false, value: { byteLength: 0 } })
      return new Promise<never>(() => {})
    },
    async cancel() { cancelled++ },
    releaseLock() {},
  }
  const transport = {
    check() {},
    async fetch(): Promise<Response> {
      return { ok: true, redirected: false, url: '',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: { getReader: () => reader } } as unknown as Response
    },
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      readOpenCodeV2NativeCut(transport,
        { endpoint: 'http://127.0.0.1:12345', directory, sessionID, pin: '2.0.21' },
        { nativeInputID, beforeCursor: 0, text: 'TEST input' })
        .then(() => 'unexpected_success', error => error instanceof Error ? error.message : 'unknown_error'),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve('nonbinary_stream_not_rejected'), 3000) }),
    ])
    assert.equal(result, 'invalid_native_read_response')
    assert.equal(reads, 1)
    assert.equal(cancelled, 1)
  } finally { clearTimeout(timer) }
})

test('public native read cut bounds tiny byte chunks before exhausting memory', async () => {
  const directory = resolve('TEST/native-cut')
  let reads = 0, cancelled = 0, requests = 0
  const reader = {
    async read() { reads++; return { done: false, value: Uint8Array.of(65) } },
    async cancel() { cancelled++ },
    releaseLock() {},
  }
  const transport = {
    check() {},
    async fetch(): Promise<Response> {
      requests++
      return { ok: true, redirected: false, url: '',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: { getReader: () => reader } } as unknown as Response
    },
  }
  await assert.rejects(readOpenCodeV2NativeCut(transport,
    { endpoint: 'http://127.0.0.1:12345', directory, sessionID, pin: '2.0.21' },
    { nativeInputID, beforeCursor: 0, text: 'TEST input' }),
  (error: unknown) => error instanceof Error && error.message === 'native_cut_byte_budget')
  assert.equal(requests, 1)
  assert.equal(reads, 8193)
  assert.equal(cancelled, 1)
})

test('direct native cut fails closed when an injected stream refuses cancellation', async () => {
  const directory = resolve('TEST/native-cut')
  for (const behavior of ['pending', 'reject'] as const) {
    let cancelled = 0, fetched = 0
    const transport = {
      check() {},
      async fetch(): Promise<Response> {
        fetched++
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)) },
          cancel() {
            cancelled++
            return behavior === 'pending'
              ? new Promise<void>(() => {})
              : Promise.reject(new Error('TEST_PRIVATE_NATIVE_CANCEL_DETAIL'))
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        readOpenCodeV2NativeCut(transport,
          { endpoint: 'http://127.0.0.1:12345', directory, sessionID, pin: '2.0.21' },
          { nativeInputID, beforeCursor: 0, text: 'TEST input' })
          .then(() => 'unexpected_success', error => error instanceof Error ? error.message : 'unknown_error'),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve('unbounded_cleanup'), 3000) }),
      ])
      assert.equal(result, 'native_read_cleanup_unknown')
      assert.equal(fetched, 1)
      assert.equal(cancelled, 1)
    } finally { clearTimeout(timer) }
  }
})


test('direct native cut reports unknown cleanup when an injected reader refuses lock release', async () => {
  const directory = resolve('TEST/native-cut')
  let fetched = 0, reads = 0, cancellations = 0, releases = 0
  const reader = {
    async read() { reads++; return { done: false, value: new Uint8Array(8 * 1024 * 1024 + 1) } },
    async cancel() { cancellations++ },
    releaseLock() { releases++; throw new Error('TEST_PRIVATE_NATIVE_LOCK_RELEASE_DETAIL') },
  }
  const transport = {
    check() {},
    async fetch(): Promise<Response> {
      fetched++
      return { ok: true, redirected: false, url: '',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: { getReader: () => reader } } as unknown as Response
    },
  }
  await assert.rejects(readOpenCodeV2NativeCut(transport,
    { endpoint: 'http://127.0.0.1:12345', directory, sessionID, pin: '2.0.21' },
    { nativeInputID, beforeCursor: 0, text: 'TEST input' }),
  (error: unknown) => error instanceof Error && error.message === 'native_read_cleanup_unknown')
  assert.equal(fetched, 1)
  assert.equal(reads, 1)
  assert.equal(cancellations, 1)
  assert.equal(releases, 1)
})


test('public native read cut refuses a never-settling injected fetch after admission revocation', async () => {
  const directory = resolve('TEST/native-cut'), controller = new AbortController()
  let fetched = 0, nativeSignal: AbortSignal | null | undefined
  const transport = {
    signal: controller.signal,
    check() {},
    fetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      fetched++; nativeSignal = init?.signal
      queueMicrotask(() => controller.abort())
      return new Promise<Response>(() => {})
    },
  }
  await assert.rejects(readOpenCodeV2NativeCut(transport,
    { endpoint: 'http://127.0.0.1:12345', directory, sessionID, pin: '2.0.21' },
    { nativeInputID, beforeCursor: 0, text: 'TEST input' }),
  (error: unknown) => error instanceof Error && error.message === 'native_read_cleanup_unknown')
  assert.equal(fetched, 1)
  assert.equal(nativeSignal?.aborted, true)
})

test('public native read cut cancels a late fetch response after revocation', async () => {
  const directory = resolve('TEST/native-cut'), controller = new AbortController()
  let deliver!: (response: Response) => void
  let fetched = 0, lateCancellations = 0, nativeSignal: AbortSignal | undefined
  const transport = {
    signal: controller.signal,
    check() {},
    fetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      fetched++; nativeSignal = init?.signal
      queueMicrotask(() => controller.abort())
      return new Promise<Response>(resolve => { deliver = resolve })
    },
  }
  await assert.rejects(readOpenCodeV2NativeCut(transport,
    { endpoint: 'http://127.0.0.1:12345', directory, sessionID, pin: '2.0.21' },
    { nativeInputID, beforeCursor: 0, text: 'TEST input' }),
  (error: unknown) => error instanceof Error && error.message === 'native_read_cleanup_unknown')
  assert.equal(fetched, 1)
  assert.equal(nativeSignal?.aborted, true)
  // A hostile injected fetch can still fulfill after the read has failed.
  // Its late, previously unobserved response body must not be left open.
  deliver(new Response(new ReadableStream<Uint8Array>({
    cancel() { lateCancellations++ },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(lateCancellations, 1)
})

test('public native read cut cancels a never-settling injected body read on revocation', async () => {
  const directory = resolve('TEST/native-cut'), controller = new AbortController()
  let fetched = 0, reads = 0, cancellations = 0, releases = 0
  const reader = {
    read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      reads++
      queueMicrotask(() => controller.abort())
      return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {})
    },
    async cancel() { cancellations++ },
    releaseLock() { releases++ },
  }
  const transport = {
    signal: controller.signal,
    check() {},
    async fetch(): Promise<Response> {
      fetched++
      return { ok: true, redirected: false, url: '',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: { getReader: () => reader } } as unknown as Response
    },
  }
  await assert.rejects(readOpenCodeV2NativeCut(transport,
    { endpoint: 'http://127.0.0.1:12345', directory, sessionID, pin: '2.0.21' },
    { nativeInputID, beforeCursor: 0, text: 'TEST input' }),
  (error: unknown) => error instanceof Error && error.message === 'invalid_native_read_response')
  assert.deepEqual({ fetched, reads, cancellations, releases },
    { fetched: 1, reads: 1, cancellations: 1, releases: 1 })
})
