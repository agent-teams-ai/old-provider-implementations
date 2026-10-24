import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { OpenCodeMessage } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/types.ts'

export async function v1Peer() {
  const directory = '/TEST/v1-original', nativeSessionId = 'ses_TESTv1', neighbor = 'ses_TESTneighbor'
  const messages: OpenCodeMessage[] = [], submittedIds: string[] = [], granted: string[] = [], aborted: string[] = []
  const submittedParts: unknown[][] = []
  let holding = false, permission = false, lostReceipt = false, foreign = false, parentWrong = false
  let heldPermission: (() => void) | undefined, holdPermission = false, heldAbort: (() => void) | undefined, holdAbort = false
  let abortAckOnly = false
  let statusOverride: { value: unknown } | undefined
  let active: string | undefined, tick = 1, reads = 0, permissionReads = 0
  const append = (id: string, text: string) => {
    const assistant = 'msg_' + id.slice(4, 16) + 'T'.repeat(14), now = tick++
    messages.push({ info: { id, sessionID: nativeSessionId, role: 'user', time: { created: now } },
      parts: [{ id: 'prt_user' + tick, type: 'text', sessionID: nativeSessionId, messageID: id, text }] })
    messages.push({ info: { id: assistant, parentID: parentWrong ? 'msg_foreign' : id, sessionID: nativeSessionId, role: 'assistant', providerID: 'TEST-provider', modelID: 'TEST-model', time: { created: tick++ } },
      parts: [{ id: 'prt_text' + tick, type: 'text', sessionID: nativeSessionId, messageID: assistant, text: 'TEST V1 reply' },
        { id: 'prt_tool' + tick, type: 'tool', callID: 'call_TEST' + tick, tool: 'TEST.tool', sessionID: nativeSessionId, messageID: assistant,
          state: { status: 'running', input: { resource: 'TEST' }, time: { start: tick } } }] })
    active = id
  }
  const complete = (cancelled = false) => {
    if (!active) {return}
    const assistant = messages.findLast(row => row.info.parentID === active || row.info.role === 'assistant')!
    assistant.info.parentID = active; assistant.info.time = { ...(assistant.info.time as object), completed: tick++ }
    if (cancelled) { assistant.info.error = { name: 'MessageAbortedError' }; delete assistant.info.finish }
    else {assistant.info.finish = 'stop'}
    const tool = assistant.parts.find(part => part.type === 'tool')!
    tool.state = { ...(tool.state as object), ...(cancelled ? { status: 'error', error: 'TEST failed' } : { status: 'completed', output: 'TEST tool output' }), time: { start: tick - 1, end: tick } }
    active = undefined
  }
  const permissions = () => active && permission ? [{ id: 'request_TEST', sessionID: nativeSessionId, permission: 'TEST.tool',
    tool: { messageID: messages.at(-1)!.info.id, callID: messages.at(-1)!.parts.find(part => part.type === 'tool')!.callID } }] : []
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://TEST.invalid'); res.setHeader('content-type', 'application/json')
    if (req.method === 'GET') {
      if (url.pathname === '/permission') {
        permissionReads++; const body = JSON.stringify(permissions())
        if (holdPermission) { holdPermission = false; heldPermission = () => res.end(body); return }
        res.end(body); return
      }
      if (url.pathname === '/question') { res.end('[]'); return }
      if (url.pathname === '/session/status') { res.end(JSON.stringify(statusOverride ? statusOverride.value : { ...(active ? { [nativeSessionId]: { type: 'busy' } } : {}), [neighbor]: { type: 'busy' } })); return }
      if (url.pathname.endsWith('/message')) {
        reads++
        const before = url.searchParams.get('before'), end = before ? messages.findIndex(row => row.info.id === before) : messages.length
        res.end(JSON.stringify(messages.slice(Math.max(0, end - Number(url.searchParams.get('limit') ?? 50)), end))); return
      }
      res.end(JSON.stringify({ id: nativeSessionId, directory: foreign ? '/TEST/foreign' : directory, version: '1.18.34' })); return
    }
    let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => {
      if (url.pathname.endsWith('/prompt_async')) {
        const input = JSON.parse(body) as { messageID: string; parts: Array<{ text: string }>; model: unknown }
        assert.match(input.messageID, /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/)
        submittedIds.push(input.messageID); submittedParts.push(input.parts); append(input.messageID, input.parts[0]!.text)
        if (!holding) {complete()}
        if (lostReceipt) { req.socket.destroy(); return }
        res.writeHead(204); res.end(); return
      }
      if (url.pathname.endsWith('/abort')) {
        aborted.push(url.pathname.split('/')[2]!); if (!abortAckOnly) {complete(true)}
        const finish = () => res.end('true'); if (holdAbort) {heldAbort = finish;} else {finish();} return
      }
      if (url.pathname.startsWith('/permission/')) {
        const decision = JSON.parse(body) as { sessionID: string; reply: string }
        assert.equal(decision.sessionID, nativeSessionId); assert.equal(decision.reply, 'once')
        granted.push(url.pathname); complete(); res.end('true'); return
      }
      res.writeHead(404); res.end('{}')
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert(address && typeof address !== 'string')
  return { endpoint: `http://127.0.0.1:${address.port}`, directory, nativeSessionId, messages, submittedIds, submittedParts, granted, aborted,
    hold: () => { holding = true }, permission: () => { holding = true; permission = true }, loseReceipt: () => { lostReceipt = true },
    toolCompletedOnly: () => { const toolPart = messages.at(-1)?.parts.find(part => part.type === 'tool'); if (toolPart) {toolPart.state = { ...(toolPart.state as object), status: 'completed', output: 'TEST output', time: { start: tick, end: tick } }} },
    failTool: () => { complete(); const tool = messages.at(-1)!.parts.find(part => part.type === 'tool')!; tool.state = { status: 'error', input: { resource: 'TEST' }, error: 'TEST failed', time: { start: tick - 1, end: tick } } },
    unqualifiedFinish: () => { complete(); const last = messages.at(-1); if (last) {last.info.finish = 'tool-calls'} },
    foreign: () => { foreign = true }, wrongParent: () => { parentWrong = true }, validParent: () => { parentWrong = false }, complete: () => complete(),
    holdPermission: () => { holdPermission = true }, releasePermission: () => { heldPermission?.(); heldPermission = undefined },
    abortAckOnly: () => { abortAckOnly = true },
    holdAbort: () => { holdAbort = true }, releaseAbort: () => { heldAbort?.(); heldAbort = undefined },
    reads: () => reads, permissionReads: () => permissionReads,
    status: (value: unknown) => { statusOverride = { value } }, nativeStatus: () => { statusOverride = undefined },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) }) },
  }
}
