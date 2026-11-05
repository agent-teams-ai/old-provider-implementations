import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createOpenCodeV2SessionControl, wasOpenCodeV2InputNotSubmitted } from '../../../../src/opencode.ts'
import { createV2ControlWire } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-control-transport.ts'

async function peer() {
  const effects: Array<{ path: string; body: unknown }> = []
  let foreign = false, loseReceipt = false, flatPermissions = false, flatInstructions = false, invalidPermissionId = false, malformedPermissionSource = false, validPermissionSource = false, calls = 0
  const server = createServer((req, res) => {
    calls++
    const url = new URL(req.url!, 'http://TEST.invalid')
    const sessionID = url.pathname.includes('ses_A') ? 'ses_A' : 'ses_B'
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET') {
      const permission = { id: (invalidPermissionId ? 'request_' : 'per_') + sessionID, sessionID: foreign ? 'ses_foreign' : sessionID, action: 'TEST.tool', resources: ['TEST-resource'],
        ...(malformedPermissionSource ? { source: { type: 'tool', messageID: 'msg_BAD%2froute', id: 'TEST-tool-call' } }
          : validPermissionSource ? { source: { type: 'tool', messageID: 'msg_TESTowned', id: 'TEST-tool-call' } } : {}) }
      if (url.pathname.endsWith('/permission')) {res.end(JSON.stringify(flatPermissions ? [permission] : { data: [permission] }))}
      else if (url.pathname.includes('/permission/')) {res.end(JSON.stringify(flatPermissions ? permission : { data: permission }))}
      else {res.end(JSON.stringify(flatInstructions ? [] : { data: [] }))}
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
    setForeign: () => { foreign = true }, loseReceipt: () => { loseReceipt = true }, flatPermissions: () => { flatPermissions = true }, flatInstructions: () => { flatInstructions = true }, invalidPermissionId: () => { invalidPermissionId = true },
    malformedPermissionSource: () => { malformedPermissionSource = true },
    validPermissionSource: () => { validPermissionSource = true }, calls: () => calls,
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
    await a.replyPermission('per_ses_A', 'reject')
    await a.cancelInbox('msg_original')
    await a.putInstruction('test.role', { role: 'TEST' })
    assert.equal((await b.pendingPermissions())[0]?.sessionId, 'ses_B')
    assert.deepEqual(await a.instructions(), [])
    assert.deepEqual(host.effects, [
      { path: `/api/session/ses_A/interrupt?${version === '2.0.0' ? 'continue' : 'resume'}=false`, body: null },
      { path: '/api/session/ses_A/permission/per_ses_A/reply', body: { [version === '2.0.0' ? 'reply' : 'decision']: 'reject' } },
      { path: '/api/session/ses_A/inbox/msg_original', body: null },
      { path: `${version === '2.0.0' ? '/api/session' : '/api/experimental/session'}/ses_A/instructions/entries/test.role`, body: { value: { role: 'TEST' } } },
    ])
    host.setForeign()
    await assert.rejects(a.replyPermission('per_ses_A', 'once'), error => { assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true })
    assert.equal(host.effects.length, 4)
  }
})

test('V2 control uses the same bounded session ID alphabet as its native driver', async t => {
  const host = await peer(); t.after(host.close)
  for (const nativeSessionId of ['ses_A-1', 'ses_A_1']) {
    const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original',
      version: '2.0.21', deadline: Date.now() + 10_000, nativeSessionId,
      readPassword: () => 'TEST-private' })
    t.after(control.dispose)
    assert.deepEqual(await control.interrupt(), { interrupted: true })
    assert.equal(host.effects.at(-1)?.path, '/api/session/' + nativeSessionId + '/interrupt?resume=false')
  }
  const before = host.calls()
  for (const nativeSessionId of ['ses_A/foreign', 'ses_A%2Fforeign', 'ses_' + 'x'.repeat(257)]) {
    assert.throws(() => createOpenCodeV2SessionControl({ endpoint: host.endpoint,
      directory: '/TEST/original', version: '2.0.21', deadline: Date.now() + 10_000,
      nativeSessionId, readPassword: () => 'TEST-private' }))
  }
  assert.equal(host.calls(), before)
})

test('native permission effect with lost response remains unknown and is not replayed', async t => {
  const host = await peer(); t.after(host.close); host.loseReceipt()
  const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version: '2.0.21',
    deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
  t.after(control.dispose)
  await assert.rejects(control.replyPermission('per_ses_A', 'once'), error => {
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


test('V2 durable always-approval is refused even via raw control wire without native reads or writes', async t => {
  // Native V2 "always" persists a project-scoped allow rule. Host has not yet
  // qualified control of those durable approvals or effective permission order.
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await peer(); t.after(host.close)
    const options = { endpoint: host.endpoint, directory: '/TEST/original', version,
      deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' }
    const control = createOpenCodeV2SessionControl(options)
    const raw = createV2ControlWire(options)
    t.after(control.dispose); t.after(raw.dispose)

    await assert.rejects(control.replyPermission('per_ses_A', 'always'), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
    })

    const key = version === '2.0.0' ? 'reply' : 'decision'
    await assert.rejects(raw.request('/api/session/ses_A/permission/per_ses_A/reply', {
      method: 'POST', body: JSON.stringify({ [key]: 'always' }),
    }), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
    })
    assert.equal(host.calls(), 0, 'no native GET or mutation before Host approval custody')
    assert.deepEqual(host.effects, [])
  }
})

test('raw V2 instruction PUT enforces the durable value byte budget before credentials or native effects', async t => {
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await peer(); t.after(host.close)
    let credentials = 0
    const raw = createV2ControlWire({ endpoint: host.endpoint, directory: '/TEST/original', version,
      deadline: Date.now() + 10_000, nativeSessionId: 'ses_A',
      readPassword: () => { credentials++; return 'TEST-private' } })
    t.after(raw.dispose)
    const entries = version === '2.0.0' ? '/api/session/ses_A/instructions/entries'
      : '/api/experimental/session/ses_A/instructions/entries'
    await assert.rejects(raw.request(entries + '/test.role', {
      method: 'PUT', body: JSON.stringify({ value: 'X'.repeat(256 * 1024 + 1) }),
    }), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
      return true
    })
    assert.equal(credentials, 0)
    assert.equal(host.calls(), 0)
    assert.deepEqual(host.effects, [])
  }
})

test('typed V2 instruction preflight is not-submitted for over-budget and non-JSON values', async t => {
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await peer(); t.after(host.close)
    let credentialReads = 0
    const control = createOpenCodeV2SessionControl({
      endpoint: host.endpoint, directory: '/TEST/original', version,
      deadline: Date.now() + 10_000, nativeSessionId: 'ses_A',
      readPassword: () => { credentialReads++; return 'TEST-private' },
    })
    t.after(control.dispose)
    for (const value of ['X'.repeat(256 * 1024 + 1), undefined, Number.POSITIVE_INFINITY]) {
      await assert.rejects(control.putInstruction('test.role', value), error => {
        assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
        return true
      })
    }
    assert.equal(credentialReads, 0)
    assert.equal(host.calls(), 0)
    assert.deepEqual(host.effects, [])
  }
})

test('invalid untyped permission decision is refused before any native read or mutation', async t => {
  const host = await peer(); t.after(host.close)
  const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version: '2.0.21',
    deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
  t.after(control.dispose)
  await assert.rejects(control.replyPermission('per_ses_A', 'unqualified' as 'once'), error => {
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
  })
  assert.equal(host.calls(), 0)
})

test('legacy flat V1-style permission responses cannot issue a native V2 grant', async t => {
  const host = await peer(); t.after(host.close); host.flatPermissions()
  const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version: '2.0.21',
    deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
  t.after(control.dispose)
  await assert.rejects(control.pendingPermissions(), /invalid_native_envelope/)
  await assert.rejects(control.replyPermission('per_ses_A', 'once'), error => {
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
  })
  assert.deepEqual(host.effects, [])
})

test('V2 instructions list requires the pinned data envelope', async t => {
  const host = await peer(); t.after(host.close); host.flatInstructions()
  const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version: '2.0.21',
    deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
  t.after(control.dispose)
  await assert.rejects(control.instructions(), /invalid_native_envelope/)
  assert.deepEqual(host.effects, [])
})

test('pinned V2 permission IDs reject old-format input and malformed native replies before grant', async t => {
  const host = await peer(); t.after(host.close)
  const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original', version: '2.0.21',
    deadline: Date.now() + 10_000, nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
  t.after(control.dispose)
  await assert.rejects(control.replyPermission('request_ses_A', 'once'), error => {
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
  })
  assert.equal(host.calls(), 0)
  host.invalidPermissionId()
  await assert.rejects(control.pendingPermissions(), /invalid_native_permission_id/)
  await assert.rejects(control.replyPermission('per_ses_A', 'once'), error => {
    assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
  })
  assert.deepEqual(host.effects, [])
})

test('malformed V2 control identifiers cannot reach a native route or mutate another session', async t => {
  const host = await peer(); t.after(host.close)
  const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint, directory: '/TEST/original',
    version: '2.0.21', deadline: Date.now() + 10_000, nativeSessionId: 'ses_A',
    readPassword: () => 'TEST-private' })
  t.after(control.dispose)
  for (const requestId of ['per', 'request_ses_A', 'per/foreign', 'per?decision=always']) {
    await assert.rejects(control.replyPermission(requestId, 'once'), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
    }, requestId)
  }
  for (const inboxId of ['', 'msg_', 'msg_A/../other', '..', 'msg_A%2Fother', 'ses_foreign']) {
    await assert.rejects(control.cancelInbox(inboxId), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
    }, inboxId)
  }
  for (const key of ['', '.', '..', '../permission', 'foreign/key', '%2E%2E', 'A', 'valid?bad']) {
    await assert.rejects(control.putInstruction(key, { value: 'TEST' }), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true); return true
    }, key)
  }
  assert.equal(host.calls(), 0)
  assert.deepEqual(host.effects, [])
})


test('malformed native permission source message ID never permits a control grant', async t => {
  // Tool-origin permissions must carry a real bounded V2 msg_ ID, not a URL
  // escape that could be confused with another resource or an old V1 ID.
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await peer(); t.after(host.close); host.malformedPermissionSource()
    const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint,
      directory: '/TEST/original', version, deadline: Date.now() + 10_000,
      nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
    t.after(control.dispose)
    await assert.rejects(control.pendingPermissions(), /invalid_native_permission_source/)
    await assert.rejects(control.replyPermission('per_ses_A', 'once'), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
      return true
    })
    assert.deepEqual(host.effects, [], 'malformed source cannot produce a native POST')
  }
})


test('session-bound control denies global MCP mutation and discovery before credentials', async t => {
  // MCP in V2 belongs to the trusted Host/project configuration boundary.
  // A session permission or interrupt capability must not turn into access
  // to the global MCP registry, even on the same authenticated loopback.
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await peer(); t.after(host.close)
    let credentials = 0
    const raw = createV2ControlWire({
      endpoint: host.endpoint, directory: '/TEST/original', version,
      deadline: Date.now() + 10_000, nativeSessionId: 'ses_A',
      readPassword: () => { credentials++; return 'TEST-private' },
    })
    t.after(raw.dispose)
    for (const [path, method] of [
      ['/api/mcp', 'GET'],
      ['/api/mcp/resource', 'GET'],
      ['/api/experimental/mcp/TEST-foreign', 'PUT'],
      ['/api/experimental/mcp/TEST-foreign/connect', 'POST'],
      ['/api/experimental/mcp/TEST-foreign/disconnect', 'POST'],
      ['/api/experimental/mcp/TEST-foreign', 'DELETE'],
    ] as const) {
      await assert.rejects(raw.request(path, { method }), error => {
        assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
        return true
      }, path)
    }
    assert.equal(credentials, 0, 'global MCP routes cannot request Host credentials')
    assert.equal(host.calls(), 0, 'no global MCP HTTP effects')
    assert.deepEqual(host.effects, [])
  }
})

test('native V2 tool-origin permission keeps valid message lineage and allows only explicit once', async t => {
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const host = await peer(); t.after(host.close); host.validPermissionSource()
    const control = createOpenCodeV2SessionControl({ endpoint: host.endpoint,
      directory: '/TEST/original', version, deadline: Date.now() + 10_000,
      nativeSessionId: 'ses_A', readPassword: () => 'TEST-private' })
    t.after(control.dispose)
    const permissions = await control.pendingPermissions()
    assert.deepEqual(permissions[0]?.source,
      { type: 'tool', messageID: 'msg_TESTowned', id: 'TEST-tool-call' })
    await control.replyPermission('per_ses_A', 'once')
    assert.deepEqual(host.effects, [{ path: '/api/session/ses_A/permission/per_ses_A/reply',
      body: { [version === '2.0.0' ? 'reply' : 'decision']: 'once' } }])
  }
})
