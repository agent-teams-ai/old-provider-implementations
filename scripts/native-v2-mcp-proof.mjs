// Isolated TEST-only MCP local process lifecycle against pinned embedded V2.0.21.
// No product Host, provider inference, user files, or production credentials.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

if (process.argv[2] === '--mcp-child') {
  // MCP stdio 2025-11-25 legacy framing is one JSON-RPC message per line.
  // This process has no tools that read files, run shell commands or use a model.
  const marker = process.env.TEST_MCP_CHILD_MARKER
  if (!marker || !isAbsolute(marker)) process.exit(2)
  const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const watchdog = setTimeout(() => process.exit(3), 25_000)
  watchdog.unref()
  for await (const line of input) {
    if (Buffer.byteLength(line) > 65536) break
    let value
    try { value = JSON.parse(line) } catch { break }
    if (value?.method === 'initialize') {
      writeFileSync(marker, JSON.stringify({ pid: process.pid, method: 'initialize' }), { flag: 'wx', mode: 0o600 })
      send(value.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} },
        serverInfo: { name: 'TEST-owned-mcp', version: '0.0.1' } })
    } else if (value?.method === 'tools/list') {
      send(value.id, { tools: [{ name: 'TEST_echo', description: 'TEST only, no external effects',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] })
    } else if (value?.method === 'tools/call') {
      // This lifecycle proof never authorizes a tool call.
      send(value.id, { isError: true, content: [{ type: 'text', text: 'TEST_not_authorized' }] })
    } else if (value?.method === 'prompts/list') send(value.id, { prompts: [] })
    else if (value?.method === 'resources/list') send(value.id, { resources: [] })
    else if (value?.method === 'resources/templates/list') send(value.id, { resourceTemplates: [] })
  }
} else {
  const receiptPath = resolve(process.env.OPENCODE_V2_MCP_RECEIPT || 'native-v2-embedded-mcp-proof.json')
  const prefix = process.env.OPENCODE_V2_EMBEDDED_NPM_PREFIX
  const expectedPlatform = process.env.OPENCODE_V2_TEST_EXPECTED_PLATFORM
  const receipt = { kind: 'TEST_V2_EMBEDDED_MCP_LIFECYCLE_ONLY', version: '2.0.21',
    qualified: false, steps: [], cleanup: false, completed: false }
  const root = mkdtempSync(join(tmpdir(), 'TEST-opencode-mcp-'))
  for (const name of ['workspace', 'home', 'config', 'cache', 'data', 'state', 'temp'])
    mkdirSync(join(root, name))
  const workspace = join(root, 'workspace'), marker = join(root, 'mcp-boot.json')
  let host, failed = false, childPid
  const originalPath = process.env.PATH ?? process.env.Path ?? ''
  // No ambient CI credentials or user config can reach the embedded engine.
  for (const name of Object.keys(process.env)) {
    if (!['LANG', 'TZ'].includes(name)) delete process.env[name]
  }
  Object.assign(process.env, {
    PATH: originalPath, HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
    XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'),
    TMPDIR: join(root, 'temp'), OPENCODE_DISABLE_MODELS_FETCH: 'true',
    CI: 'true', NO_COLOR: '1',
    ...(process.platform === 'win32' ? {
      USERPROFILE: join(root, 'home'), APPDATA: join(root, 'config'),
      LOCALAPPDATA: join(root, 'data'), TEMP: join(root, 'temp'), TMP: join(root, 'temp'),
    } : {}),
  })
  const childPresent = pid => {
    try { process.kill(pid, 0); return true }
    catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }
  try {
    if (expectedPlatform !== `${process.platform}-${process.arch}`)
      throw Error('TEST_MCP_runner_platform_mismatch')
    if (!prefix || !isAbsolute(prefix)) throw Error('TEST_MCP_prefix_missing')
    const packageRoot = realpathSync(join(prefix, 'node_modules', '@opencode', 'sdk'))
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    if (manifest.name !== '@opencode/sdk' || manifest.version !== '2.0.21')
      throw Error('TEST_MCP_unpinned_sdk')
    const target = manifest.exports?.['.']?.import?.default ?? manifest.exports?.['.']?.import
    if (typeof target !== 'string' || !target.startsWith('./'))
      throw Error('TEST_MCP_missing_export')
    const entry = realpathSync(join(packageRoot, target))
    if (!entry.startsWith(packageRoot + sep)) throw Error('TEST_MCP_escape_export')
    const { OpenCode } = await import(pathToFileURL(entry).href)
    const options = { app: { name: 'TEST-embedded-MCP', version: '2.0.21' },
      database: { path: join(root, 'data', 'mcp.sqlite') }, events: { persist: true },
      models: { fetch: false }, config: { directory: join(root, 'config'), project: false },
      fs: { filewatcher: false, fff: false } }
    host = await OpenCode.create(options)
    receipt.steps.push('TEST_pinned_embedded_SDK_started')
    // Only the immutable TEST script and its local temporary workspace may spawn.
    const script = realpathSync(new URL(import.meta.url).pathname)
    const server = 'TEST-owned-mcp'
    await host.mcp.add({ server, location: { directory: workspace },
      config: { type: 'local', command: [process.execPath, script, '--mcp-child'],
        cwd: workspace, environment: { TEST_MCP_CHILD_MARKER: marker },
        protocol: 'legacy', timeout: { startup: 6000, catalog: 6000, execution: 6000 } } })
    receipt.steps.push('TEST_real_MCP_server_registered')
    let status
    for (let attempt = 0; attempt < 35; attempt++) {
      const result = await host.mcp.list({ location: { directory: workspace } })
      const items = result?.data
      status = Array.isArray(items) ? items.find(row => row.name === server)?.status?.status : null
      if (status === 'connected') break
      await delay(200)
    }
    if (status !== 'connected') throw Error('TEST_MCP_native_connection_not_ready')
    const boot = JSON.parse(readFileSync(marker, 'utf8'))
    if (!Number.isSafeInteger(boot.pid) || boot.pid <= 0 || boot.method !== 'initialize' ||
        boot.pid === process.pid || !childPresent(boot.pid))
      throw Error('TEST_MCP_owned_child_missing')
    childPid = boot.pid
    receipt.steps.push('TEST_MCP_stdio_handshake_and_owned_process')
    await host.mcp.disconnect({ server, location: { directory: workspace } })
    receipt.steps.push('TEST_MCP_disconnect_accepted')
    await host.mcp.remove({ server, location: { directory: workspace } })
    const after = await host.mcp.list({ location: { directory: workspace } })
    if (Array.isArray(after?.data) && after.data.some(row => row.name === server))
      throw Error('TEST_MCP_removed_server_still_listed')
    receipt.steps.push('TEST_MCP_server_removed')
    await host.close(); host = undefined
    for (let attempt = 0; attempt < 40 && childPresent(childPid); attempt++) await delay(100)
    if (childPresent(childPid)) throw Error('TEST_MCP_child_survived_owned_cleanup')
    receipt.steps.push('TEST_MCP_child_stopped_after_host_close')
  } catch (error) {
    failed = true
    receipt.failure = String(error instanceof Error ? error.message : error)
  } finally {
    if (host) {
      try { await host.close() } catch (error) {
        failed = true; receipt.hostCleanupFailure = String(error)
      }
    }
    if (childPid && childPresent(childPid)) {
      failed = true; receipt.childCleanupFailure = 'TEST_MCP_child_not_closed'
    }
    try { rmSync(root, { recursive: true, force: true }) } catch (error) {
      failed = true; receipt.rootCleanupFailure = String(error)
    }
    receipt.cleanup = !receipt.hostCleanupFailure && !receipt.childCleanupFailure && !receipt.rootCleanupFailure
    receipt.completed = !failed && receipt.cleanup
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ completed: receipt.completed, steps: receipt.steps,
      failure: receipt.failure, cleanup: receipt.cleanup }))
    if (!receipt.completed) process.exitCode = 1
  }
}
