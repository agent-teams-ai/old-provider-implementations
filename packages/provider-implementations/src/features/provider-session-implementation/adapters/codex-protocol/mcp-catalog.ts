import { createHash } from 'node:crypto'
import { record } from './wire-frames.ts'

export type CodexConfiguredMcpServer = Readonly<{ name: string; enabled: boolean; transport: Readonly<{ type: 'stdio'; command: string } | { type: 'streamable_http'; url: string }> }>
/** Private metadata only. Raw native env/header/auth fields never leave this decoder. */
export type CodexConfiguredMcpCatalog = Readonly<{ digest: string; servers: readonly CodexConfiguredMcpServer[] }>
const invalid = (): never => { throw new Error('codex.mcp.invalid-catalog') }
const text = (value: unknown, max = 8192): value is string => typeof value === 'string' && Buffer.byteLength(value) <= max && !value.includes('\0')
function canonical(value: unknown, depth = 0): string {
  if (depth > 16 || (typeof value === 'number' && !Number.isFinite(value))) { return invalid() }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') { return JSON.stringify(value) }
  if (Array.isArray(value)) { return '[' + value.map(field => canonical(field, depth + 1)).join(',') + ']' }
  const row = record(value)
  if (!row) { return invalid() }
  return '{' + Object.keys(row).toSorted().map(key => JSON.stringify(key) + ':' + canonical(row[key], depth + 1)).join(',') + '}'
}
/** Pinned 0.162.0 `mcp list --json`: configured plus installed-plugin rows, NOT runtime contributions. */
export function decodeCodexConfiguredMcpCatalog(raw: string): CodexConfiguredMcpCatalog {
  if (Buffer.byteLength(raw) > 1_048_576) { return invalid() }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return invalid() }
  if (!Array.isArray(parsed) || parsed.length > 256) { return invalid() }
  const normalized: Record<string, unknown>[] = []
  const servers = parsed.map(value => {
    const row = record(value), transport = record(row?.transport)
    if (!row || !text(row.name, 256) || !row.name.length || /[\r\n]/u.test(row.name) || typeof row.enabled !== 'boolean' || !transport ||
      Object.keys(row).some(key => !['name', 'enabled', 'disabled_reason', 'transport', 'startup_timeout_sec', 'tool_timeout_sec', 'auth_status'].includes(key)) ||
      !['stdio', 'streamable_http'].includes(String(transport.type))) { return invalid() }
    const kind = transport.type
    if (kind === 'stdio' ? !text(transport.command) || !transport.command.length : !text(transport.url) || !transport.url.length) { return invalid() }
    // Auth status is a live observation; it cannot silently mutate a configuration fingerprint.
    const { auth_status: _auth, ...configuration } = row
    normalized.push(configuration)
    return Object.freeze({ name: row.name, enabled: row.enabled, transport: kind === 'stdio'
      ? Object.freeze({ type: 'stdio' as const, command: transport.command as string })
      : Object.freeze({ type: 'streamable_http' as const, url: transport.url as string }) })
  }).toSorted((a, b) => a.name.localeCompare(b.name))
  if (new Set(servers.map(server => server.name)).size !== servers.length) { return invalid() }
  const canonicalRows = normalized.toSorted((a, b) => String(a.name).localeCompare(String(b.name)))
  return Object.freeze({ digest: createHash('sha256').update(canonical(canonicalRows)).digest('hex'), servers: Object.freeze(servers) })
}

/** Validate an original private persisted census without reinterpreting native configuration. */
export function captureCodexConfiguredMcpCatalog(value: unknown): CodexConfiguredMcpCatalog {
  try {
    const catalog = record(value)
    if (!catalog || Object.keys(catalog).toSorted().join(',') !== 'digest,servers' || typeof catalog.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(catalog.digest) || !Array.isArray(catalog.servers) || catalog.servers.length > 256) { return invalid() }
    const servers = catalog.servers.map(raw => {
      const row = record(raw), transport = record(row?.transport)
      if (!row || Object.keys(row).toSorted().join(',') !== 'enabled,name,transport' || !text(row.name, 256) || !row.name.length || /[\r\n]/u.test(row.name) || typeof row.enabled !== 'boolean' || !transport) { return invalid() }
      if (transport.type === 'stdio' && Object.keys(transport).toSorted().join(',') === 'command,type' && text(transport.command) && transport.command.length) {
        return Object.freeze({ name: row.name, enabled: row.enabled, transport: Object.freeze({ type: 'stdio' as const, command: transport.command }) })
      }
      if (transport.type === 'streamable_http' && Object.keys(transport).toSorted().join(',') === 'type,url' && text(transport.url) && transport.url.length) {
        return Object.freeze({ name: row.name, enabled: row.enabled, transport: Object.freeze({ type: 'streamable_http' as const, url: transport.url }) })
      }
      return invalid()
    })
    if (new Set(servers.map(row => row.name)).size !== servers.length) { return invalid() }
    return Object.freeze({ digest: catalog.digest, servers: Object.freeze(servers) })
  } catch { return invalid() }
}
