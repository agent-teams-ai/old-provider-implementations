import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { decodeCodexConfiguredMcpCatalog } from '../../../../src/features/provider-session-implementation/adapters/codex-protocol/mcp-catalog.ts'
import { readCodexConfiguredMcpCatalog } from '../../../../src/features/provider-session-implementation/adapters/codex-protocol/mcp-catalog-probe.ts'
import { codexMcpPolicyArgs, codexMcpConfigurationMatches, managedCodexMcpParameters } from '../../../../src/features/provider-session-implementation/adapters/codex-protocol/mcp-policy.ts'
import { exactMcpPolicyReady } from '../../../../src/features/provider-session-implementation/adapters/codex-protocol/mcp-status.ts'
import { createCodexDriverFactory } from '../../../../src/features/provider-session-implementation/adapters/codex-protocol/driver-factory.ts'
import type { CodexDriverConfig } from '../../../../src/features/provider-session-implementation/adapters/codex-protocol/driver-config.ts'
import type { CodexMcpServerStatus, CodexMcpStatusRequest } from '../../../../src/features/provider-session-implementation/adapters/codex-protocol/mcp-status.ts'
const raw = (name = 'TEST.foreign', secret = 'TEST-private') => JSON.stringify([{ name, enabled: true, disabled_reason: null, transport: { type: 'stdio', command: '/TEST/dummy', args: [], env: { TEST_SECRET: secret }, env_vars: [], cwd: null }, startup_timeout_sec: null, tool_timeout_sec: null, auth_status: 'unsupported' }])
const catalog = () => decodeCodexConfiguredMcpCatalog(raw())
const policy = () => ({ catalog: catalog(), selected: { team: { url: 'http://127.0.0.1:1/TEST-team' } } })
const configuration = (team: Record<string, unknown> = { url: 'http://127.0.0.1:1/TEST-team', enabled: true, environment_id: 'local', tool_timeout_sec: null }) => ({ config: { features: { apps: false }, mcp_servers: { 'TEST.foreign': { command: '/TEST/dummy', enabled: false }, team } } })
const statusPage = async (rows: CodexMcpServerStatus[]) => ({ data: rows, nextCursor: null })
const status = (name: string, runtimeStatus: CodexMcpServerStatus['runtimeStatus'] = 'connected', tools: string[] = []): CodexMcpServerStatus => ({ name, runtimeStatus, authStatus: 'unsupported', toolsError: null, tools: Object.fromEntries(tools.map(toolName => [toolName, { name: toolName }])) })

test('pinned actual native metadata bytes include plugin name and veto, but no raw private values escape projection', async () => {
  const nativeRaw = await readFile(new URL('./mcp-list-0.162.metadata.json', import.meta.url), 'utf8')
  const parsed = decodeCodexConfiguredMcpCatalog(nativeRaw)
  assert.deepEqual(parsed.servers.map(row => [row.name, row.enabled]), [['TEST_configured_disabled', false], ['TEST_configured_only', true], ['TEST_plugin_only', true], ['TEST_veto', false]])
  const before = catalog(); assert(!JSON.stringify(before).includes('TEST-private'))
  assert.notEqual(before.digest, decodeCodexConfiguredMcpCatalog(raw('TEST.foreign', 'TEST-changed')).digest)
  const authChanged = JSON.parse(raw('TEST.foreign', 'TEST-changed')); authChanged[0].auth_status = 'unknown'
  assert.equal(decodeCodexConfiguredMcpCatalog(raw('TEST.foreign', 'TEST-changed')).digest, decodeCodexConfiguredMcpCatalog(JSON.stringify(authChanged)).digest)
  for (const value of ['oops', nativeRaw + nativeRaw, JSON.stringify([{ name: 'x', enabled: true, transport: {} }]), JSON.stringify([...JSON.parse(nativeRaw), ...JSON.parse(nativeRaw)])]) {assert.throws(() => decodeCodexConfiguredMcpCatalog(value), /invalid-catalog/u)}
})

test('one captured metadata launch snapshots config, requires actual zero exit and confirms original cleanup without retries', async () => {
  let launches = 0, disposals = 0
  const config = { cwd: '/TEST/project', executablePath: '/TEST/codex', environment: { HOME: '/TEST/home', CODEX_HOME: '/TEST/codex-home', PATH: '/usr/bin:/bin' }, timeoutMs: 1000, canRead: () => true,
    launch(request: { args: readonly string[]; env: Readonly<Record<string, string>>; signal: AbortSignal }) { launches++; assert.deepEqual(request.args, ['mcp', 'list', '--json']); assert.equal(request.env.HOME, '/TEST/home'); config.environment.HOME = '/TEST/mutated'; return { async *read() { yield Buffer.from(raw()) }, terminal: Promise.resolve({ exitCode: 0, signal: null }), async dispose() { disposals++; return true } } } }
  assert.equal((await readCodexConfiguredMcpCatalog(config)).digest, catalog().digest); assert.equal(launches, 1); assert.equal(disposals, 1)
  for (const exitCode of [1, null]) {await assert.rejects(readCodexConfiguredMcpCatalog({ ...config, launch: () => ({ async *read() { yield Buffer.from(raw()) }, terminal: Promise.resolve({ exitCode, signal: null }), dispose: async () => true }) }), /unavailable/u)}
  await assert.rejects(readCodexConfiguredMcpCatalog({ ...config, launch: () => ({ async *read() { yield Buffer.from(raw()) }, terminal: Promise.resolve({ exitCode: 0, signal: null }), dispose: async () => false }) }), /cleanup-unconfirmed/u)
  let forbidden = 0; await assert.rejects(readCodexConfiguredMcpCatalog({ ...config, canRead: () => false, launch: () => { forbidden++; throw new Error('no') } }), /cancelled/u); assert.equal(forbidden, 0)
})

test('one top-level TOML overlay quotes dotted names and native merged stale fields fail exact pre-thread configuration gate', () => {
  const args = codexMcpPolicyArgs(policy()); assert.equal(args[1], 'features.apps=false'); assert(args[3]?.includes('"TEST.foreign"={"command"="/TEST/dummy","enabled"=false}'))
  assert(codexMcpConfigurationMatches(configuration(), policy()))
  const leaked = configuration(); Object.assign(leaked.config.mcp_servers.team, { http_headers: { TEST_LEAK: 'TEST-secret' } }); assert(!codexMcpConfigurationMatches(leaked, policy()))
  const unselected = configuration(); unselected.config.mcp_servers['TEST.foreign'].enabled = true; assert(!codexMcpConfigurationMatches(unselected, policy()))
  assert(!managedCodexMcpParameters({ cwd: '/TEST', config: { 'features.apps': true } }, {}))
  assert(!managedCodexMcpParameters({}, { selectedCapabilityRoots: ['foreign'] }))
})

test('native ConfigToml selected HTTP defaults require local environment and exact inherited configuration', () => {
  const row = { url: 'http://127.0.0.1:1/TEST-team', enabled: true, environment_id: 'local', tool_timeout_sec: null }
  assert(codexMcpConfigurationMatches(configuration(row), policy()))
  const { environment_id: _environment, ...withoutEnvironment } = row
  const { tool_timeout_sec: _timeout, ...withoutTimeout } = row
  assert(!codexMcpConfigurationMatches(configuration(withoutEnvironment), policy()))
  assert(!codexMcpConfigurationMatches(configuration(withoutTimeout), policy()))
  for (const inherited of [
    { environment_id: 'remote-TEST' }, { environment_id: null }, { tool_timeout_sec: 30 },
    { startup_timeout_sec: 15 }, { required: true }, { startup_readiness: 'catalog' },
    { env_http_headers: { TEST_HEADER: 'TEST_ENV' } }, { http_headers_helper: '/TEST/helper' },
    { disabled_tools: ['TEST-tool'] }, { unrecognized: false },
  ]) {
    assert(!codexMcpConfigurationMatches(configuration({ ...row, ...inherited }), policy()))
  }
})

test('native ConfigToml stdio empty args and nullable timeout match only captured defaults or explicit values', () => {
  const selected = { team: { command: '/TEST/selected' } }, supplied = { catalog: catalog(), selected }
  const row = { command: '/TEST/selected', args: [], enabled: true, environment_id: 'local', tool_timeout_sec: null }
  assert(codexMcpConfigurationMatches(configuration(row), supplied))
  const { args: _args, ...withoutArgs } = row
  assert(!codexMcpConfigurationMatches(configuration(withoutArgs), supplied))
  assert(!codexMcpConfigurationMatches(configuration({ ...row, args: ['inherited'] }), supplied))
  assert(!codexMcpConfigurationMatches(configuration({ ...row, env: { TEST_EXTRA: 'TEST-value' } }), supplied))
  const explicit = { catalog: catalog(), selected: { team: { command: '/TEST/selected', args: ['--TEST', ''], tool_timeout_sec: 30, startup_timeout_sec: 15 } } }
  const configured = { ...row, args: ['--TEST', ''], tool_timeout_sec: 30, startup_timeout_sec: 15 }
  assert(codexMcpConfigurationMatches(configuration(configured), explicit))
  assert(!codexMcpConfigurationMatches(configuration({ ...configured, tool_timeout_sec: null }), explicit))
  assert(!codexMcpConfigurationMatches(configuration({ ...configured, args: [] }), explicit))
})

test('entire status gate rejects unselected connected server, extra Team tools, hidden later page and duplicate cursor', async () => {
  const selected = ['team'], disabled = ['TEST.foreign'], required = { team: ['TEST-tool'] }
  assert(!await exactMcpPolicyReady({ listMcpServerStatus: async () => ({ data: [], nextCursor: null }) }, 'thread', { selected: [], disabled: [], required }, new AbortController().signal))
  assert(await exactMcpPolicyReady({ listMcpServerStatus: () => statusPage([status('team', 'connected', ['TEST-tool']), status('TEST.foreign', 'disabled')]) }, 'thread', { selected, disabled, required }, new AbortController().signal))
  for (const rows of [[status('team', 'connected', ['TEST-tool']), status('unselected')], [status('team', 'connected', ['TEST-tool', 'extra'])], [status('team', 'connected', ['TEST-tool']), status('TEST.foreign')]]) {assert(!await exactMcpPolicyReady({ listMcpServerStatus: () => statusPage(rows) }, 'thread', { selected, disabled, required }, new AbortController().signal))}
  let duplicatePage = 0
  assert(!await exactMcpPolicyReady({ listMcpServerStatus: async () => ({ data: [status('team', 'connected', ['TEST-tool'])], nextCursor: duplicatePage++ === 0 ? 'second' : null }) }, 'thread', { selected, disabled, required }, new AbortController().signal))
  assert.equal(duplicatePage, 2)
  let polling = 0
  assert(await exactMcpPolicyReady({ listMcpServerStatus: () => statusPage([status('team', polling++ === 0 ? 'starting' : 'connected', ['TEST-tool'])]) }, 'thread', { selected, disabled, required }, new AbortController().signal))
  assert.equal(polling, 2)
  let pages = 0; assert(!await exactMcpPolicyReady({ listMcpServerStatus: async (_request: CodexMcpStatusRequest) => ({ data: pages++ === 0 ? [status('team', 'connected', ['TEST-tool'])] : [status('foreign')], nextCursor: pages === 1 ? 'next' : null }) }, 'thread', { selected, disabled, required }, new AbortController().signal)); assert.equal(pages, 2)
})

test('actual driver orders catalog/config admission before thread/start and holds later drift before any turn', async t => {
  const responses = new PassThrough(), writes: { method: string; params?: Record<string, unknown> }[] = []; let validCatalog = true, checkCount = 0
  const config: CodexDriverConfig = { binding: { tenantId: 'TEST', projectId: 'TEST', sessionId: 'TEST', generation: 1 }, configRevision: 'TEST', protocolRevision: '0.162.0', accountBinding: 'TEST', trustedBinding: 'TEST',
    transport: { async *read(signal) { signal.addEventListener('abort', () => responses.destroy(), { once: true }); for await (const chunk of responses) {yield chunk} }, write(frame) { const request = JSON.parse(frame); writes.push(request); if (!request.id) {return;} let result: unknown = {}; if (request.method === 'initialize') {result = { codexHome: '/TEST/home', platformFamily: 'unix', platformOs: 'macos' };} if (request.method === 'config/read') {result = configuration();} if (request.method === 'thread/start') {result = { thread: { id: 'TEST-thread' }, model: 'TEST', modelProvider: 'TEST', cwd: '/TEST' };} if (request.method === 'mcpServerStatus/list') {result = { data: [{ name: 'team', runtimeStatus: 'connected', authStatus: 'unsupported', toolsError: null, tools: { 'TEST-tool': { name: 'TEST-tool', inputSchema: {} } }, resources: [], resourceTemplates: [] }], nextCursor: null };} responses.write(JSON.stringify({ id: request.id, result }) + '\n') } },
    initialize: { clientInfo: { name: 'TEST', version: '1' }, capabilities: { experimentalApi: true } }, threadParams: { cwd: '/TEST', model: 'TEST' }, mcpPolicy: policy(), verifyMcpCatalog: async () => { checkCount++; return validCatalog }, requiredMcpTools: { team: ['TEST-tool'] },
    limits: { queuedInputs: 1, inputBytes: 4096, outputBytes: 8192, outputEvents: 64, pendingInteractions: 2, timeoutMs: 1000 }, probe: async () => true, confirmStopped: async () => true }
  const factory = createCodexDriverFactory({ resolveConfiguration: async () => config, readCheckpoint: async () => {}, capabilities: ['text', 'tools'] })
  const { driver } = await factory.open({ ...config.binding, configRevision: 'TEST', requiredCapabilities: ['text', 'tools'] }); t.after(() => driver.close())
  assert.equal(checkCount, 2); const methods = writes.map(row => row.method); assert(methods.indexOf('config/read') < methods.indexOf('thread/start')); assert(methods.indexOf('thread/start') < methods.indexOf('mcpServerStatus/list'))
  validCatalog = false; const before = writes.length
  assert.deepEqual(await driver.submit({ inputId: 'TEST-input', operationRef: 'TEST-original', content: 'TEST no work' }), { ok: false, code: 'dependency-unavailable', delivery: 'known-not-sent' })
  assert.equal(writes.length, before); assert(!writes.some(row => row.method === 'turn/start'))
})

test('stdout EOF cannot publish a catalog before original child terminal and cleanup', async () => {
  const {promise:completed,resolve:terminal}=Promise.withResolvers<{exitCode:number|null;signal:string|null}>(); let disposed = 0, settled = false
  const result = readCodexConfiguredMcpCatalog({ executablePath: '/TEST/codex', cwd: '/TEST/project', environment: {HOME:'/TEST/home', CODEX_HOME:'/TEST/codex-home',PATH:'/usr/bin:/bin'},timeoutMs:1000,canRead:()=>true,
    launch:()=>({async *read(){yield Buffer.from(raw())},terminal:completed,dispose:async()=>{disposed++;return true}}) }).then(value=>{settled=true;return value})
  await new Promise<void>(resolve=>{setImmediate(resolve)});assert.equal(settled,false);assert.equal(disposed,0)
  terminal({exitCode:0,signal:null});assert.equal((await result).digest,catalog().digest);assert.equal(disposed,1)
})
