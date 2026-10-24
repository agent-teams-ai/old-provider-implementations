import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createOpenCodeV2ExecutionTransport, readOpenCodeV2NativeCut, projectOpenCodeV2NativeTurn } from '../../../../src/opencode.ts'
import { cut, sessionID, nativeInputID } from './v2-cut-fixture.ts'

async function fixture(mode: 'stable' | 'changing' | 'cycle' | 'foreign' | 'max' | 'overmax') {
  const value = cut(), directory = '/TEST/native-cut'
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
      if (mode === 'max' || mode === 'overmax') {
        const count = mode === 'max' ? 4096 : 4097
        while (rows.length < count) { const seq = rows.length; rows.push({ id: `evt_max${seq}`, type: 'session.updated',
          durable: { aggregateID: sessionID, seq }, data: { sessionID }, location: { directory } }) }
      }
      const watermark = rows.at(-1)!.durable.seq
      res.setHeader('content-type', 'text/event-stream')
      res.end([...rows, { type: 'log.synced', aggregateID: sessionID, seq: watermark }]
        .map(row => `data: ${JSON.stringify(row)}\n\n`).join(''))
      return
    }
    res.setHeader('content-type', 'application/json')
    if (url.pathname.endsWith('/message')) {
      pages++
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
    res.end(JSON.stringify({ id: sessionID, location: { directory: mode === 'foreign' ? '/TEST/foreign' : directory },
      agent: 'TEST-agent', model: { providerID: 'TEST-provider', id: 'TEST-model' }, time: { created: 1 } }))
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
  for (const mode of ['changing', 'cycle', 'foreign'] as const) {
    const host = await fixture(mode); t.after(host.close)
    const transport = createOpenCodeV2ExecutionTransport({ endpoint: host.endpoint, directory: host.directory,
      version: '2.0.21', deadline: Date.now() + 10_000, readPassword: () => 'TEST-private' })
    t.after(() => transport.dispose())
    await assert.rejects(readOpenCodeV2NativeCut(transport,
      { endpoint: host.endpoint, directory: host.directory, sessionID, pin: '2.0.21' },
      { nativeInputID, beforeCursor: 0, text: 'TEST input' }),
    mode === 'changing' ? /mutable_native_readback/ : mode === 'cycle' ? /incomplete_native_transcript/ : /binding_mismatch/)
    if (mode === 'cycle') {assert.equal(host.counts().pages, 2)}
    if (mode === 'foreign') {assert.deepEqual(host.counts(), { logs: 0, pages: 0, requests: 1 })}
  }
})


test('native finite cut accepts 4096 events plus synced frame and rejects a 4097th event', async t => {
  for (const mode of ['max', 'overmax'] as const) {
    const host = await fixture(mode); t.after(host.close)
    const transport = createOpenCodeV2ExecutionTransport({ endpoint: host.endpoint, directory: host.directory,
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
