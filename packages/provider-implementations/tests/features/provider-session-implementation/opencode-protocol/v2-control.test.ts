import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createOpenCodeV2SessionControl, wasOpenCodeV2InputNotSubmitted } from '../../../../src/opencode.ts'

async function peer() {
  const effects: Array<{ path: string; body: unknown }> = []
  let foreign = false, loseReceipt = false, calls = 0
  const server = createServer((req, res) => {
    calls++
    const url = new URL(req.url!, 'http://TEST.invalid')
    const sessionID = url.pathname.includes('ses_A') ? 'ses_A' : 'ses_B'
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET') {
      const permission = { id: 'request_' + sessionID, sessionID: foreign ? 'ses_foreign' : sessionID, action: 'TEST.tool', resources: ['TEST-resource'] }
      if (url.pathname.endsWith('/permission')) {res.end(JSON.stringify([permission]))}
      else if (url.pathname.includes('/permission/')) {res.end(JSON.stringify(permission))}
      else {res.end('[]')}
      return
    }
    let text = ''
    req.on('data', chunk => { text += chunk })
    req.on('end', () => {
      if (text) {assert.equal(req.headers['content-type'], 'application/json')}
      effects.push({ path: req.url!, body: text ? JSON.parse(text) : null })
      if (loseReceipt) { req.socket.destroy(); return }
      if (url.pathname.endsWith('/interrupt')) {res.end('{"interrupted":true}')}
      else { res.writeHead(204); res.end() }
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert(address && typeof address !== 'string')
  return { endpoint: `http://127.0.0.1:${address.port}`, effects,
    setForeign: () => { foreign = true }, loseReceipt: () => { loseReceipt = true }, calls: () => calls,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) }) },
  }
}

test('bound native control translates both dialects without touching neighboring session or host', async t => {
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await peer(); t.after(host.close)
    const a = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version,
      deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
    const b = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version,
      deadline: Date.now() + 10_000, nativeSessionId: 'ses_B', readPassword: () => 'TEST-private' })
    t.after(a.dispose); t.after(b.dispose)
    assert.deepEqual(await a.interrupt(), { interrupted: true })
    await a.replyPermission('request_ses_A', 'reject')
    await a.cancelInbox('msg_original')
    await a.putInstruction('test.role', { role: 'TEST' })
    assert.equal((await b.pendingPermissions())[0]?.sessionId, 'ses_B')
    assert.deepEqual(host.effects, [
      { path: `/api/session/ses_A/interrupt?${version === '2.0.0' ? 'continue' : 'resume'}=false`, body: null },
      { path: '/api/session/ses_A/permission/request_ses_A/reply', body: { [version === '2.0.0' ? 'reply' : 'decision']: 'reject' } },
      { path: '/api/session/ses_A/inbox/msg_original', body: null },
      { path: `${version === '2.0.0' ? '/api/session' : '/api/experimental/session'}/ses_A/instructions/entries/test.role`, body: { value: { role: 'TEST' } } },
    ])
    host.setForeign()
    await assert.rejects(a.replyPermission('request_ses_A', 'once'), error => { assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true })
    assert.equal(host.effects.length, 4)
  }
})

test('native permission effect with lost response remains unknown and is not replayed', async t => {
  const host = await peer(); t.after(host.close); host.loseReceipt()
  const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version: '2.0.21',
    deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
  t.after(control.dispose)
  await assert.rejects(control.replyPermission('request_ses_A', 'once'), error => {
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
    return true
  })
  assert.equal(host.effects.length, 1)
})

test('control credential callback revocation is checked before native invocation', async t => {
  const host = await peer(); t.after(host.close)
  const abort = new AbortController()
  const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version: '2.0.21',
    deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', signal: abort.signal,
    readPassword: () => { abort.abort(); return 'TEST-private' } })
  await assert.rejects(control.interrupt(), error => { assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true })
  await control.dispose()
  assert.equal(host.calls(), 0)
})


test('invalid untyped permission decision is refused before any native read or mutation', async t => {
  const host = await peer(); t.after(host.close)
  const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version: '2.0.21',
    deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
  t.after(control.dispose)
  await assert.rejects(control.replyPermission('request_ses_A', 'unqualified' as 'once'), error => {
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
  })
  assert.equal(host.calls(), 0)
})
