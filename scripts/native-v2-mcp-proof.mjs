// Isolated TEST-only MCP local process lifecycle on exact pinned V2.0.21/V2.1.4.
// No product Host, provider inference, user files, or production credentials.
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const pinnedVersion = process.env.OPENCODE_V2_MCP_VERSION ?? '2.0.21'
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
      send(value.id, { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'TEST-owned-mcp', version: '0.0.1' } })
    } else if (value?.method === 'tools/list') {
      send(value.id, { tools: [{ name: 'TEST_echo', description: 'TEST only, no external effects',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] })
    } else if (value?.method === 'tools/call') {
      // This lifecycle proof never authorizes a tool call.
      send(value.id, { isError: true, content: [{ type: 'text', text: 'TEST_not_authorized' }] })
    } else if (value?.method === 'prompts/list') send(value.id, { prompts: [] })
    else if (value?.method === 'resources/list') send(value.id, { resources: [
      { name: 'TEST-only-resource', uri: 'test://owned/marker', description: 'TEST no filesystem read' },
    ] })
    else if (value?.method === 'resources/templates/list') send(value.id, { resourceTemplates: [] })
  }
} else {
  const receiptPath = resolve(process.env.OPENCODE_V2_MCP_RECEIPT || 'native-v2-embedded-mcp-proof.json')
  const prefix = process.env.OPENCODE_V2_EMBEDDED_NPM_PREFIX
  const expectedPlatform = process.env.OPENCODE_V2_TEST_EXPECTED_PLATFORM
  if (!['2.0.21', '2.1.4'].includes(pinnedVersion)) throw Error('TEST_MCP_unqualified_version')
  const receipt = { kind: 'TEST_V2_EMBEDDED_MCP_LIFECYCLE_ONLY', version: pinnedVersion,
    qualified: false, steps: [], cleanup: false, completed: false }
  const root = mkdtempSync(join(tmpdir(), 'TEST-opencode-mcp-'))
  for (const name of ['workspace', 'neighbor', 'home', 'config', 'cache', 'data', 'state', 'temp'])
    mkdirSync(join(root, name))
  const workspace = join(root, 'workspace'), marker = join(root, 'mcp-boot.json')
  let host, failed = false, childPid, removePid, hostClosePid
  const originalPath = process.env.PATH ?? process.env.Path ?? ''
  // Windows Node 24 needs SystemRoot for OS cryptographic initialization. Keep
  // only this non-secret trusted OS directory, not ambient user credentials.
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
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
      ...(typeof systemRoot === 'string' && win32.isAbsolute(systemRoot) && systemRoot.length <= 1024
        ? { SystemRoot: systemRoot } : {}),
      USERPROFILE: join(root, 'home'), APPDATA: join(root, 'config'),
      LOCALAPPDATA: join(root, 'data'), TEMP: join(root, 'temp'), TMP: join(root, 'temp'),
    } : {}),
  })
  const childPresent = pid => {
    try { process.kill(pid, 0); return true }
    catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }
  const waitGone = async pid => {
    for (let attempt = 0; attempt < 40 && childPresent(pid); attempt++) await delay(100)
    return !childPresent(pid)
  }
  try {
    if (expectedPlatform !== `${process.platform}-${process.arch}`)
      throw Error('TEST_MCP_runner_platform_mismatch')
    if (process.platform === 'win32' && !process.env.SystemRoot)
      throw Error('TEST_MCP_windows_systemroot_unavailable')
    if (!prefix || !isAbsolute(prefix)) throw Error('TEST_MCP_prefix_missing')
    const packageRoot = realpathSync(join(prefix, 'node_modules', '@opencode', 'sdk'))
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    if (manifest.name !== '@opencode/sdk' || manifest.version !== pinnedVersion)
      throw Error('TEST_MCP_unpinned_sdk')
    const target = manifest.exports?.['.']?.import?.default ?? manifest.exports?.['.']?.import
    if (typeof target !== 'string' || !target.startsWith('./'))
      throw Error('TEST_MCP_missing_export')
    const entry = realpathSync(join(packageRoot, target))
    if (!entry.startsWith(packageRoot + sep)) throw Error('TEST_MCP_escape_export')
    const { OpenCode } = await import(pathToFileURL(entry).href)
    const options = { app: { name: 'TEST-embedded-MCP', version: pinnedVersion },
      database: { path: join(root, 'data', 'mcp.sqlite') }, events: { persist: true },
      models: { fetch: false }, config: { directory: join(root, 'config'), project: false },
      fs: { filewatcher: false, fff: false } }
    host = await OpenCode.create(options)
    receipt.steps.push('TEST_pinned_embedded_SDK_started')
    // Only the immutable TEST script and its local temporary workspace may spawn.
    const script = realpathSync(fileURLToPath(import.meta.url))
    const server = 'TEST-owned-mcp'
    const localMcp = target => ({ type: 'local',
      command: [process.execPath, script, '--mcp-child'],
      cwd: workspace, environment: { TEST_MCP_CHILD_MARKER: target },
      protocol: 'legacy', timeout: { startup: 6000, catalog: 6000, execution: 6000 } })
    await host.mcp.add({ server, location: { directory: workspace }, config: localMcp(marker) })
    receipt.steps.push('TEST_real_MCP_server_registered')
    let status, lastStatus
    for (let attempt = 0; attempt < 35; attempt++) {
      const result = await host.mcp.list({ location: { directory: workspace } })
      const items = result?.data
      lastStatus = Array.isArray(items) ? items.find(row => row.name === server)?.status : null
      status = lastStatus?.status ?? null
      if (status === 'connected') break
      await delay(200)
    }
    if (status !== 'connected') {
      // Exact bounded diagnostic without publishing the native error text,
      // runner paths, credentials, or the TEST child environment.
      const category = typeof lastStatus?.error === 'string'
        ? lastStatus.error.match(/\b(?:ENOENT|EACCES|EINVAL|EPERM|timeout|handshake|spawn|transport)\b/i)?.[0]?.toLowerCase() ?? 'other'
        : 'none'
      // Only a closed category and handshake bit are safe for public TEST artifacts.
      // Native error text can contain paths or future upstream diagnostic payloads.
      receipt.mcpConnectFailure = { status, category, childHandshakeSeen: existsSync(marker) }
      throw Error('TEST_MCP_native_connection_not_ready')
    }
    const boot = JSON.parse(readFileSync(marker, 'utf8'))
    if (!Number.isSafeInteger(boot.pid) || boot.pid <= 0 || boot.method !== 'initialize' ||
        boot.pid === process.pid || !childPresent(boot.pid))
      throw Error('TEST_MCP_owned_child_missing')
    childPid = boot.pid
    receipt.steps.push('TEST_MCP_stdio_handshake_and_owned_process')
    // Actual MCP resource round trip, not just a status flag. The neighboring
    // TEST workspace must not observe a server added to the selected location.
    const catalog = await host.mcp.resource.catalog({ location: { directory: workspace } })
    const resources = catalog?.data?.resources
    if (!Array.isArray(resources) || resources.length !== 1 ||
        resources[0]?.server !== server || resources[0]?.uri !== 'test://owned/marker')
      throw Error('TEST_MCP_native_resource_catalog_mismatch')
    const neighborDirectory = join(root, 'neighbor')
    const neighbor = await host.mcp.list({ location: { directory: neighborDirectory } })
    if (!Array.isArray(neighbor?.data) || neighbor.data.some(row => row.name === server))
      throw Error('TEST_MCP_foreign_workspace_server_disclosed')
    const neighborCatalog = await host.mcp.resource.catalog({ location: { directory: neighborDirectory } })
    if (!Array.isArray(neighborCatalog?.data?.resources) ||
        neighborCatalog.data.resources.some(row => row.server === server || row.uri === 'test://owned/marker'))
      throw Error('TEST_MCP_foreign_workspace_resource_disclosed')
    receipt.steps.push('TEST_MCP_native_resource_discovery_and_workspace_isolation')
    await host.mcp.disconnect({ server, location: { directory: workspace } })
    const disabled = await host.mcp.list({ location: { directory: workspace } })
    if (disabled?.data?.find(row => row.name === server)?.status?.status !== 'disabled' ||
        !(await waitGone(childPid)))
      throw Error('TEST_MCP_disconnect_did_not_stop_own_child')
    const disconnectedCatalog = await host.mcp.resource.catalog({ location: { directory: workspace } })
    if (!Array.isArray(disconnectedCatalog?.data?.resources) ||
        disconnectedCatalog.data.resources.some(row => row.server === server || row.uri === 'test://owned/marker'))
      throw Error('TEST_MCP_disconnected_resource_still_exposed')
    receipt.steps.push('TEST_MCP_disconnect_stopped_child')
    await host.mcp.remove({ server, location: { directory: workspace } })
    const after = await host.mcp.list({ location: { directory: workspace } })
    if (Array.isArray(after?.data) && after.data.some(row => row.name === server))
      throw Error('TEST_MCP_removed_server_still_listed')
    const removedCatalog = await host.mcp.resource.catalog({ location: { directory: workspace } })
    if (!Array.isArray(removedCatalog?.data?.resources) ||
        removedCatalog.data.resources.some(row => row.server === server || row.uri === 'test://owned/marker'))
      throw Error('TEST_MCP_removed_resource_still_exposed')
    receipt.steps.push('TEST_MCP_server_removed')
    // Independent active child: remove directly, without first disconnecting.
    const removeServer = 'TEST-owned-mcp-direct-remove'
    const removeMarker = join(root, 'remove-boot.json')
    await host.mcp.add({ server: removeServer, location: { directory: workspace },
      config: localMcp(removeMarker) })
    let removeConnected = false
    for (let attempt = 0; attempt < 35; attempt++) {
      const list = await host.mcp.list({ location: { directory: workspace } })
      if (list?.data?.some(row => row.name === removeServer && row.status?.status === 'connected')) {
        removeConnected = true; break
      }
      await delay(200)
    }
    if (!removeConnected) throw Error('TEST_MCP_direct_remove_child_not_connected')
    const removeBoot = JSON.parse(readFileSync(removeMarker, 'utf8'))
    if (!Number.isSafeInteger(removeBoot.pid) || removeBoot.pid <= 0 ||
        removeBoot.pid === childPid || !childPresent(removeBoot.pid))
      throw Error('TEST_MCP_direct_remove_child_not_owned')
    removePid = removeBoot.pid
    receipt.steps.push('TEST_MCP_direct_remove_child_active')
    await host.mcp.remove({ server: removeServer, location: { directory: workspace } })
    if (!(await waitGone(removePid))) throw Error('TEST_MCP_direct_remove_child_survived')
    const noRemove = await host.mcp.list({ location: { directory: workspace } })
    const noRemoveCatalog = await host.mcp.resource.catalog({ location: { directory: workspace } })
    if (!Array.isArray(noRemove?.data) || noRemove.data.some(row => row.name === removeServer) ||
        !Array.isArray(noRemoveCatalog?.data?.resources) ||
        noRemoveCatalog.data.resources.some(row => row.server === removeServer || row.uri === 'test://owned/marker'))
      throw Error('TEST_MCP_direct_remove_leaked_server_or_resource')
    receipt.steps.push('TEST_MCP_direct_remove_stopped_active_child')
    // Different live TEST child: verify closing an owning embedded Host itself
    // performs teardown, not simply a prior explicit disconnect/remove.
    const secondServer = 'TEST-owned-mcp-host-close'
    const secondMarker = join(root, 'hostclose-boot.json')
    await host.mcp.add({ server: secondServer, location: { directory: workspace },
      config: localMcp(secondMarker) })
    let secondConnected = false
    for (let attempt = 0; attempt < 35; attempt++) {
      const list = await host.mcp.list({ location: { directory: workspace } })
      if (list?.data?.some(row => row.name === secondServer && row.status?.status === 'connected')) {
        secondConnected = true; break
      }
      await delay(200)
    }
    if (!secondConnected) throw Error('TEST_MCP_host_close_child_not_connected')
    const secondBoot = JSON.parse(readFileSync(secondMarker, 'utf8'))
    if (!Number.isSafeInteger(secondBoot.pid) || secondBoot.pid <= 0 ||
        secondBoot.pid === childPid || !childPresent(secondBoot.pid))
      throw Error('TEST_MCP_host_close_child_not_owned')
    hostClosePid = secondBoot.pid
    receipt.steps.push('TEST_MCP_second_child_active_before_host_close')
    await host.close(); host = undefined
    if (!(await waitGone(hostClosePid))) throw Error('TEST_MCP_child_survived_host_close')
    receipt.steps.push('TEST_MCP_host_close_stopped_active_child')
  } catch (error) {
    failed = true
    receipt.failure = String(error instanceof Error ? error.message : error)
  } finally {
    if (host) {
      try { await host.close() } catch (error) {
        failed = true; receipt.hostCleanupFailure = String(error)
      }
    }
    if ((childPid && childPresent(childPid)) ||
        (removePid && childPresent(removePid)) ||
        (hostClosePid && childPresent(hostClosePid))) {
      failed = true; receipt.childCleanupFailure = 'TEST_MCP_owned_child_not_closed'
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
