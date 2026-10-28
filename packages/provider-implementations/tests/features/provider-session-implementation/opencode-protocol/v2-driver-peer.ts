import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { cut } from './v2-cut-fixture.ts'

/** Real disposable HTTP peer, with two isolated native sessions on one synthetic host. */
export async function driverPeer() {
  const directory = '/TEST/native-driver', sessionId = 'ses_TESTdriver'
  let submitted = 0, interrupted = 0, foreign = false, lostReceipt = false, hold = false, permissionMode = false, replies = 0
  let value = cut(), base = cut(), queued: { id: string; text: string } | undefined
  let pauseInterrupt = false, releaseInterrupt: (() => void) | undefined
  let holdGrant = false, releaseGrant: (() => void) | undefined
  let holdPermissionDetail = false, permissionDetails = 0, releasePermissionDetail: (() => void) | undefined
  let unknownLineage = false
  let holdPermissionList = false, permissionLists = 0, sessionReads = 0, releasePermissionList: (() => void) | undefined
  const submittedIds: string[] = []
  const cancelled: string[] = [], neighborInbox = new Set(['msg_TESTunrelated'])
  const outputs = new Map<string, ReturnType<typeof cut>>()
  const reset = () => {
    value = cut(); value.messages.data = []; value.log.events = [{ id: 'evt_created', type: 'session.created', seq: 0,
      aggregateID: sessionId, data: { sessionID: sessionId } }]; value.log.watermark = 0
  }
  reset()
  const complete = (pending = false) => {
    if (!queued) {return}
    value = structuredClone(base)
    const turn = cut(), nativeInput = turn.nativeInputID
    const offset = value.log.events.length - 1
    const replacement = (source: string) => source.replaceAll(turn.sessionID, sessionId).replaceAll(nativeInput, queued!.id)
      .replaceAll('msg_TESTassistant', 'msg_TESTassistant' + submitted).replaceAll('msg_TEST9', 'msg_TESTidle' + submitted)
      .replaceAll('TEST input', queued!.text)
    const rows = JSON.parse(replacement(JSON.stringify(turn.messages.data))) as typeof value.messages.data
    value.messages.data.push(...rows)
    for (const row of turn.log.events.slice(1)) {
      const translated = JSON.parse(replacement(JSON.stringify(row))) as typeof row
      translated.seq += offset; translated.id = 'evt_driver' + translated.seq
      // Native terminal message ID is derived from this durable event ID.
      if (translated.type === 'session.execution.succeeded') {
        const idle = rows.find(item => item.type === 'idle'); if (idle) {idle.id = 'msg_driver' + translated.seq}
      }
      value.log.events.push(translated)
    }
    value.log.watermark = value.log.events.at(-1)!.seq
    value = { ...value, sessionID: sessionId, nativeInputID: queued.id, originalText: queued.text }
    if (pending) {
      value.log.events = value.log.events.filter(row => row.seq <= offset || !['session.tool.success', 'session.text.ended', 'session.step.ended', 'session.execution.succeeded'].includes(row.type))
      value.log.watermark = value.log.events.at(-1)!.seq
      value.messages.data = value.messages.data.filter(row => !rows.includes(row) || row.type !== 'idle')
      const assistant = rows.find(row => row.type === 'assistant')
      if (assistant) {
        const tool = (assistant.data.content as Array<Record<string, unknown>>).find(part => part.type === 'tool')!
        assistant.data = { ...assistant.data, content: [{ ...tool, state: { ...(tool.state as object), status: 'running' } }] }
      }
      if (unknownLineage) {for (const row of value.log.events) {
        if (row.seq > offset && row.type === 'session.execution.started') { row.type = 'session.updated' }
      }}
    } else { outputs.set(queued.id, structuredClone(value)); queued = undefined }
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://TEST.invalid')
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET') {
      if (url.pathname.endsWith('/log')) {
        res.setHeader('content-type', 'text/event-stream')
        res.end([...value.log.events.map(row => ({ id: row.id, type: row.type, durable: { aggregateID: sessionId, seq: row.seq },
          data: row.data, location: { directory } })), { type: 'log.synced', aggregateID: sessionId, seq: value.log.watermark }]
          .map(row => `data: ${JSON.stringify(row)}\n\n`).join('')); return
      }
      if (url.pathname.endsWith('/message')) {
        const data = url.searchParams.has('cursor') ? [] : value.messages.data.map(row => ({ ...row.data, id: row.id,
          type: row.type, time: { ...(row.data.time as object | undefined), created: row.timeCreated } }))
        res.end(JSON.stringify({ data, cursor: data.length ? { previous: 'start', next: 'end' } : { previous: null, next: null } })); return
      }
      if (url.pathname.includes('/permission')) {
        const permission = { id: 'request_TESTpermission', sessionID: sessionId, action: 'TEST.tool', resources: ['TEST-resource'],
          source: { type: 'tool', messageID: 'msg_TESTassistant' + submitted, id: 'TEST-tool' } }
        const body = JSON.stringify(url.pathname.endsWith('/permission') ? (permissionMode && queued ? [permission] : []) : permission)
        if (url.pathname.endsWith('/permission')) {
          permissionLists++
          if (holdPermissionList) { releasePermissionList = () => res.end(body); return }
        } else {
          permissionDetails++
          if (holdPermissionDetail) { releasePermissionDetail = () => res.end(body); return }
        }
        res.end(body); return
      }
      sessionReads++
      res.end(JSON.stringify({ id: sessionId, location: { directory: foreign ? '/TEST/foreign' : directory },
        agent: 'TEST-agent', model: { providerID: 'TEST-provider', id: 'TEST-model' }, time: { created: 1 } })); return
    }
    let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => {
      if (url.pathname.endsWith('/prompt')) {
        assert.equal(req.method, 'POST'); submitted++
        const input = JSON.parse(body) as { id: string; text: string }
        submittedIds.push(input.id); queued = input; base = structuredClone(value); if (!hold) {complete();} else if (permissionMode) {complete(true)}
        if (lostReceipt) { req.socket.destroy(); return }
        res.end(JSON.stringify({ id: input.id, sessionID: sessionId, type: 'user', delivery: 'queue', time: { created: 1 }, payload: { text: input.text } })); return
      }
      if (req.method === 'DELETE' && url.pathname.includes('/inbox/')) {
        const id = url.pathname.split('/').at(-1)!; cancelled.push(id)
        neighborInbox.delete(id)
        if (queued?.id === id) {
          queued = undefined
          const seq = value.log.events.length
          value.log.events.push({ id: 'evt_cancel' + seq, seq, type: 'session.inbox.cancelled', aggregateID: sessionId, data: { sessionID: sessionId, inboxID: id } })
          value.log.watermark = seq
        }
        res.writeHead(204); res.end(); return
      }
      if (url.pathname.endsWith('/reply')) { replies++; const finish = () => { complete(); res.writeHead(204); res.end() }; if (holdGrant) {releaseGrant = finish;} else {finish();} return }
      if (url.pathname.endsWith('/interrupt')) { interrupted++; const finish = () => res.end('{"interrupted":true}'); if (pauseInterrupt) {releaseInterrupt = finish;} else {finish();} return }
      res.writeHead(404); res.end('{}')
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert(address && typeof address !== 'string')
  return { endpoint: `http://127.0.0.1:${address.port}`, directory, sessionId, outputs, submittedIds, cancelled, neighborInbox, complete: () => complete(),
    pauseGrant: () => { holdGrant = true }, releaseGrant: () => { holdGrant = false; releaseGrant?.(); releaseGrant = undefined },
    pauseReplyPreflight: () => { holdPermissionDetail = true }, releaseReplyPreflight: () => { holdPermissionDetail = false; releasePermissionDetail?.(); releasePermissionDetail = undefined },
    permissionDetails: () => permissionDetails,
    unknownLineage: () => { unknownLineage = true }, validLineage: () => { unknownLineage = false },
    pausePermissions: () => { holdPermissionList = true }, releasePermissions: () => { holdPermissionList = false; releasePermissionList?.(); releasePermissionList = undefined },
    permissionLists: () => permissionLists, sessionReads: () => sessionReads,
    pauseInterrupt: () => { pauseInterrupt = true }, releaseInterrupt: () => { releaseInterrupt?.(); releaseInterrupt = undefined },
    hold: () => { hold = true }, permission: () => { hold = true; permissionMode = true }, foreign: () => { foreign = true }, loseReceipt: () => { lostReceipt = true },
    counts: () => ({ submitted, interrupted, replies }),
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) }) },
  }
}
