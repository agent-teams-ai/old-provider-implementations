import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises'
import { createOpenCodeV1DriverFactory } from '../../../../src/opencode.ts'
import type { OpenCodeV1DriverConfig } from '../../../../src/opencode.ts'
import type { Event, OpenConfig } from '@agent-teams/provider-session-contracts'
import type { OpenCodeMessage } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/types.ts'

const request: OpenConfig = { tenantId: 'TEST-tenant', projectId: 'TEST-project', sessionId: 'TEST-session', generation: 1, configRevision: 'TEST-r1', requiredCapabilities: ['text', 'permission'] }
const nativeSessionId = 'ses_TESTpermission', directory = '/TEST/v1-permission', permissionId = 'per_TESTrequest'
const input = { inputId: 'TEST-input', operationRef: 'TEST-operation', content: 'TEST permission input' }
async function until(predicate: () => boolean) { for (let i = 0; i < 100; i++) { if (predicate()) return; await turn() }; assert.fail('TEST bounded memory observation') }
function fixture(reply?: (incoming: Request) => Promise<Response> | Response) {
  const messages: OpenCodeMessage[] = [], posts: string[] = [], bodies: unknown[] = []
  let pending = false
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  const config: OpenCodeV1DriverConfig = {
    endpoint: 'http://127.0.0.1:1', workspacePath: directory, nativeSessionId, version: '1.19.4',
    binding: { tenantId: request.tenantId, projectId: request.projectId, sessionId: request.sessionId, generation: request.generation }, configRevision: request.configRevision,
    trustedBinding: 'TEST-host', accountBinding: 'TEST-account', profileBinding: 'TEST-profile', runBinding: 'TEST-run', model: { providerID: 'TEST-provider', modelID: 'TEST-model' },
    limits: { queuedInputs: 2, inputBytes: 4096, outputEvents: 100, outputBytes: 100_000, pendingInteractions: 2, timeoutMs: 5000 }, probe: async () => true, confirmStopped: async () => true,
    fetchImpl: async (url, init) => {
      const incoming = new Request(url, init), path = new URL(incoming.url).pathname
      if (incoming.method === 'GET') {
        if (path.endsWith('/message')) return json(messages)
        if (path === '/permission') return json(pending ? [{ id: permissionId, sessionID: nativeSessionId, permission: 'bash', tool: { messageID: messages[1]!.info.id, callID: 'call_TESTpermission' } }] : [])
        if (path === '/question') return json([])
        if (path === '/session/status') return json(pending ? { [nativeSessionId]: { type: 'busy' } } : {})
        return json({ id: nativeSessionId, directory })
      }
      posts.push(path)
      if (path === '/session/' + nativeSessionId + '/prompt_async') {
        const body = await incoming.json() as { messageID: string; parts: { text: string }[] }
        const assistant = body.messageID + 'TEST'
        messages.push({ info: { id: body.messageID, sessionID: nativeSessionId, role: 'user', time: { created: 1 } }, parts: [{ id: 'prt_TESTuser', sessionID: nativeSessionId, messageID: body.messageID, type: 'text', text: body.parts[0]!.text }] },
          { info: { id: assistant, parentID: body.messageID, sessionID: nativeSessionId, role: 'assistant', providerID: 'TEST-provider', modelID: 'TEST-model', time: { created: 2 } },
            parts: [{ id: 'prt_TESTtool', sessionID: nativeSessionId, messageID: assistant, type: 'tool', callID: 'call_TESTpermission', tool: 'bash', state: { status: 'running', input: { command: 'TEST command' }, time: { start: 2 } } }] })
        pending = true; return new Response(null, { status: 204 })
      }
      // Exact API embedded in pinned native 1.19.4: no legacy-route acceptance or fallback.
      if (path !== '/permission/' + permissionId + '/reply') return json({ error: 'TEST missing route' }, 404)
      bodies.push(await incoming.clone().json())
      if (reply) return reply(incoming)
      assert.ok(['once', 'reject'].includes((bodies.at(-1) as { reply: string }).reply))
      assert.deepEqual(Object.keys(bodies.at(-1) as object), ['reply'])
      pending = false
      const assistant = messages[1]!; assistant.info.time = { created: 2, completed: 3 }; assistant.info.finish = 'stop'
      assistant.parts[0]!.state = { status: 'completed', input: { command: 'TEST command' }, output: 'TEST result', time: { start: 2, end: 3 } }
      return json(true)
    },
  }
  return { config, posts, bodies, async open() {
    const { driver } = await createOpenCodeV1DriverFactory({ capabilities: ['text', 'tools', 'permission'], resolveConfiguration: async () => config, readCheckpoint: async () => undefined }).open(request)
    const events: Event[] = []; const done = (async () => { for await (const event of driver.observe()) events.push(event) })()
    return { driver, events, async interaction() {
      assert.equal((await driver.submit(input)).ok, true)
      await until(() => events.some(event => event.kind === 'interaction'))
      const event = events.find(event => event.kind === 'interaction'); assert.ok(event?.kind === 'interaction'); return event.interactionRef
    }, async close() { await driver.close(); await done } }
  } }
}
for (const decision of ['allow', 'deny'] as const) {
  test('public V1 ' + decision + ' uses one exact native permission reply route/body and original lineage', async () => {
    const f = fixture(), opened = await f.open()
    try {
      const ref = await opened.interaction()
      assert.deepEqual(await opened.driver.respondToInteraction(ref, { kind: 'permission', decision }), { ok: true, value: undefined })
      for (let i = 0; i < 100 && !opened.events.some(event => event.kind === 'result'); i++) await delay(10)
      assert.ok(opened.events.some(event => event.kind === 'result'))
      assert.deepEqual(f.posts, ['/session/' + nativeSessionId + '/prompt_async', '/permission/' + permissionId + '/reply'])
      assert.deepEqual(f.bodies, [{ reply: decision === 'allow' ? 'once' : 'reject' }])
      assert.deepEqual(opened.events.filter(event => event.kind === 'result').map(event => [event.inputId, event.operationRef, event.outcome]), [[input.inputId, input.operationRef, 'succeeded']])
      assert.deepEqual(await opened.driver.respondToInteraction(ref, { kind: 'permission', decision }), { ok: false, code: 'stale' })
      assert.equal(f.posts.length, 2)
    } finally { await opened.close() }
  })
}
test('public V1 lost permission POST stays unknown without retry or alternate-route probing', async () => {
  const f = fixture(() => { throw new TypeError('TEST reset', { cause: { code: 'ECONNRESET' } }) }), opened = await f.open()
  try {
    const ref = await opened.interaction()
    assert.deepEqual(await opened.driver.respondToInteraction(ref, { kind: 'permission', decision: 'allow' }), { ok: false, code: 'unknown' })
    await until(() => opened.events.some(event => event.kind === 'result'))
    assert.deepEqual(f.posts, ['/session/' + nativeSessionId + '/prompt_async', '/permission/' + permissionId + '/reply'])
    assert.ok(opened.events.some(event => event.kind === 'result' && event.inputId === input.inputId && event.outcome === 'unknown'))
  } finally { await opened.close() }
})
test('public V1 exact permission reply honors its endpoint abort before the longer wire budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 })
  let signal: AbortSignal | undefined
  const f = fixture(incoming => { signal = incoming.signal; return new Promise<Response>((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })) }), opened = await f.open()
  try {
    const ref = await opened.interaction(), response = opened.driver.respondToInteraction(ref, { kind: 'permission', decision: 'allow' })
    await until(() => signal !== undefined); assert.equal(signal!.aborted, false)
    t.mock.timers.tick(2500); assert.equal(signal!.aborted, true)
    assert.deepEqual(await response, { ok: false, code: 'unknown' })
    assert.equal(f.posts.filter(path => path.includes('/permission/')).length, 1)
  } finally { await opened.close() }
})
