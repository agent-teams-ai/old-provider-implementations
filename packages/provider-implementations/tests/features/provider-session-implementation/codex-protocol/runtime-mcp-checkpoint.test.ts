import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { createCodexDriverFactory } from '../../../../src/codex.ts'
import type { CodexDriverConfig } from '../../../../src/codex.ts'
import { captureDriverConfig } from '../../../../src/features/provider-session-implementation/adapters/codex-protocol/driver-config.ts'
import { decodeCodexConfiguredMcpCatalog } from '../../../../src/features/provider-session-implementation/adapters/codex-protocol/mcp-catalog.ts'

const runtimeName = 'TEST-runtime'
const firstUrl = 'http://127.0.0.1:12345/TEST-first'
const secondUrl = 'http://127.0.0.1:12346/TEST-second'
const required = { [runtimeName]: ['TEST-tool'] }
const request = { tenantId: 'TEST-tenant', projectId: 'TEST-project', sessionId: 'TEST-session', generation: 1, configRevision: 'TEST-config', requiredCapabilities: ['text', 'tools'] }
const policy = (url: string) => ({
  catalog: structuredClone(decodeCodexConfiguredMcpCatalog('[]')),
  selected: {
    [runtimeName]: { url, bearer_token_env_var: 'TEST_RUNTIME_TOKEN', enabled_tools: ['TEST-tool'], tools: { 'TEST-tool': { approval_mode: 'approve' as const } }, startup_timeout_sec: 1, tool_timeout_sec: 1 },
    'TEST-user': { url: 'https://TEST-user.invalid/mcp', http_headers: { Authorization: 'TEST-user-auth' } },
  },
})
function fixture(t: TestContext, url = firstUrl, checkpoint?: unknown, optedIn = true) {
  const responses = new PassThrough(), writes: { method: string; params?: Record<string, unknown> }[] = []
  const config: CodexDriverConfig = {
    binding: { tenantId: request.tenantId, projectId: request.projectId, sessionId: request.sessionId, generation: request.generation },
    configRevision: request.configRevision, protocolRevision: '0.162.0', accountBinding: 'TEST-account', trustedBinding: 'TEST-original-authority',
    transport: {
      async *read(signal) { signal.addEventListener('abort', () => responses.destroy(), { once: true }); for await (const chunk of responses) { yield chunk } },
      write(frame) {
        const message = JSON.parse(frame); writes.push(message)
        if (message.id === undefined) { return }
        let result: unknown = {}
        if (message.method === 'initialize') { result = { codexHome: '/TEST/home', platformFamily: 'unix', platformOs: 'linux' } }
        if (message.method === 'config/read') {
          result = { config: { features: { apps: false }, mcp_servers: Object.fromEntries(Object.entries(nativePolicy).map(([name, row]) => [name, { ...row, enabled: true, environment_id: 'local', tool_timeout_sec: row.tool_timeout_sec ?? null }])) } }
        }
        if (message.method === 'thread/start' || message.method === 'thread/resume') { result = { thread: { id: 'TEST-original-thread' } } }
        if (message.method === 'mcpServerStatus/list') {
          result = { data: Object.keys(nativePolicy).map(name => ({ name, runtimeStatus: 'connected', authStatus: 'unsupported', toolsError: null,
            tools: name === runtimeName ? { 'TEST-tool': { name: 'TEST-tool', inputSchema: {} } } : {}, resources: [], resourceTemplates: [] })), nextCursor: null }
        }
        responses.write(JSON.stringify({ id: message.id, result }) + '\n')
      },
    },
    initialize: { clientInfo: { name: 'TEST-client', version: '1' }, capabilities: { experimentalApi: true } },
    threadParams: { cwd: '/TEST/workspace', model: 'TEST-model' },
    mcpPolicy: policy(url), verifyMcpCatalog: async () => true, requiredMcpTools: required,
    limits: { queuedInputs: 1, inputBytes: 4096, outputBytes: 8192, outputEvents: 64, pendingInteractions: 2, timeoutMs: 1000 },
    probe: async () => true, confirmStopped: async () => true,
  }
  if (optedIn) { Object.assign(config, { runtimeMcpServer: runtimeName }) }
  let nativePolicy: Record<string, Record<string, unknown>> = structuredClone(config.mcpPolicy!.selected)
  const factory = createCodexDriverFactory({ capabilities: ['text', 'tools'], resolveConfiguration: async () => config, readCheckpoint: async () => checkpoint })
  t.after(() => responses.destroy())
  return { config, writes, factory, staleNativeEndpoint() { nativePolicy[runtimeName]!.url = firstUrl } }
}
async function originalCheckpoint(t: TestContext, optedIn = true) {
  const original = fixture(t, firstUrl, undefined, optedIn)
  const { driver } = await original.factory.open(request)
  const checkpoint = driver.checkpoint(); assert(checkpoint.ok)
  await driver.close()
  return { original, checkpoint: checkpoint.value }
}

test('explicit runtime MCP endpoint rotates across generations while resuming the exact selected thread', async t => {
  const { checkpoint } = await originalCheckpoint(t)
  const next = fixture(t, secondUrl, checkpoint)
  Object.assign(next.config, { binding: { ...next.config.binding, generation: 2 } })
  const opened = await next.factory.open({ ...request, generation: 2, checkpointRef: 'TEST-selected' })
  t.after(() => opened.driver.close())
  const resume = next.writes.find(message => message.method === 'thread/resume')
  assert.equal(resume?.params?.threadId, 'TEST-original-thread')
  assert(!next.writes.some(message => message.method === 'thread/start' || message.method === 'turn/start'))
  const runtime = next.config.mcpPolicy!.selected[runtimeName]!
  assert('url' in runtime)
  assert.equal(runtime.url, secondUrl, 'compatibility projection never changes actual native policy')
  assert((await opened.driver.checkReadiness()).ok)
})

test('runtime endpoint declaration does not bypass current native URL verification', async t => {
  const { checkpoint } = await originalCheckpoint(t)
  const next = fixture(t, secondUrl, checkpoint)
  next.staleNativeEndpoint()
  await assert.rejects(next.factory.open({ ...request, checkpointRef: 'TEST-selected' }), /open-failed/)
  assert(next.writes.some(message => message.method === 'config/read'))
  assert(!next.writes.some(message => message.method === 'thread/start' || message.method === 'thread/resume'))
})

test('unmarked consumers retain exact checkpoint bytes and cannot infer a runtime endpoint on restore', async t => {
  const { original, checkpoint } = await originalCheckpoint(t, false)
  const config = captureDriverConfig(original.config, request), { tenantId, projectId, sessionId } = config.binding
  const previous = createHash('sha256').update(JSON.stringify({ tenantId, projectId, sessionId, configRevision: config.configRevision,
    protocolRevision: config.protocolRevision, trustedBinding: config.trustedBinding, accountBinding: config.accountBinding,
    threadParams: config.threadParams, turnParams: {}, requiredMcpTools: config.requiredMcpTools, mcpPolicy: config.mcpPolicy })).digest('hex')
  assert.equal((checkpoint as { compatibility: string }).compatibility, previous)
  for (const optedIn of [false, true]) {
    const next = fixture(t, secondUrl, checkpoint, optedIn)
    await assert.rejects(next.factory.open({ ...request, checkpointRef: 'TEST-selected' }), /checkpoint-incompatible/)
    assert.equal(next.writes.length, 0, 'no guessed migration or fresh-thread fallback')
  }
})

test('runtime MCP declaration snapshots and refuses missing, malformed, inherited or non-HTTP targets', async t => {
  const original = fixture(t)
  const captured = captureDriverConfig(original.config, request)
  Object.assign(original.config, { runtimeMcpServer: 'TEST-user' })
  assert.equal(captured.runtimeMcpServer, runtimeName)
  const invalid: unknown[] = ['', 'missing', 'x\0', 'x\n', 'x'.repeat(257), 7, null]
  for (const name of invalid) {
    const candidate = fixture(t)
    Object.assign(candidate.config, { runtimeMcpServer: name })
    await assert.rejects(candidate.factory.open(request), /invalid-config/)
    assert.equal(candidate.writes.length, 0)
  }
  for (const change of [
    (config: CodexDriverConfig) => Object.assign(config, { mcpPolicy: undefined }),
    (config: CodexDriverConfig) => Object.assign(config, { requiredMcpTools: {} }),
    (config: CodexDriverConfig) => Object.assign(config, { requiredMcpTools: Object.create(required) }),
    (config: CodexDriverConfig) => Object.assign(config.mcpPolicy!.selected, { [runtimeName]: { command: '/TEST/stdio' } }),
    (config: CodexDriverConfig) => Object.assign(config.mcpPolicy!.selected[runtimeName]!, { url: 'ftp://TEST-non-http.invalid/mcp' }),
    (config: CodexDriverConfig) => Object.assign(config, { mcpPolicy: { ...config.mcpPolicy, selected: Object.create(config.mcpPolicy!.selected) } }),
  ]) {
    const candidate = fixture(t); change(candidate.config)
    await assert.rejects(candidate.factory.open(request), /invalid-config/)
    assert.equal(candidate.writes.length, 0)
  }
})

test('only the declared runtime URL may rotate; authority, catalog, foreign transport and native policy remain bound', async t => {
  const { checkpoint } = await originalCheckpoint(t)
  const mutations: ((config: CodexDriverConfig) => void)[] = [
    config => Object.assign(config, { trustedBinding: 'TEST-other-authority' }),
    config => Object.assign(config, { runtimeMcpServer: 'TEST-user', requiredMcpTools: { ...required, 'TEST-user': ['TEST-tool'] } }),
    config => Object.assign(config.mcpPolicy!.catalog, { digest: 'd'.repeat(64) }),
    config => Object.assign(config.mcpPolicy!.selected['TEST-user']!, { url: 'https://TEST-other.invalid/mcp' }),
    config => Object.assign(config.mcpPolicy!.selected['TEST-user']!, { http_headers: { Authorization: 'TEST-other-auth' } }),
    config => Object.assign(config.mcpPolicy!.selected[runtimeName]!, { enabled_tools: ['TEST-other'] }),
    config => Object.assign(config.mcpPolicy!.selected[runtimeName]!, { tools: { 'TEST-other': { approval_mode: 'approve' } } }),
    config => Object.assign(config.mcpPolicy!.selected[runtimeName]!, { startup_timeout_sec: 2 }),
    config => Object.assign(config.mcpPolicy!.selected[runtimeName]!, { tool_timeout_sec: 2 }),
    config => Object.assign(config.mcpPolicy!.selected[runtimeName]!, { bearer_token_env_var: 'TEST_OTHER_TOKEN' }),
    config => Object.assign(config.mcpPolicy!.selected[runtimeName]!, { http_headers: { Authorization: 'TEST-extra-auth' } }),
  ]
  for (const change of mutations) {
    const candidate = fixture(t, secondUrl, checkpoint); change(candidate.config)
    await assert.rejects(candidate.factory.open({ ...request, checkpointRef: 'TEST-selected' }), /checkpoint-incompatible/)
    assert.equal(candidate.writes.length, 0)
  }
})
