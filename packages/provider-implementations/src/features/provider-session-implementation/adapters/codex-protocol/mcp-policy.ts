import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { record } from './wire-frames.ts'
import { captureCodexConfiguredMcpCatalog } from './mcp-catalog.ts'
import type { CodexConfiguredMcpCatalog } from './mcp-catalog.ts'

const text = z.string().max(65536).refine(value => !value.includes('\0'))
const name = z.string().min(1).max(256).refine(value => !/[\0\r\n]/u.test(value))
const fields = { startup_timeout_sec: z.number().positive().max(180000).optional(), tool_timeout_sec: z.number().positive().max(180000).optional(),
  enabled_tools: z.array(name).max(256).optional(), tools: z.record(name, z.object({ approval_mode: z.literal('approve') }).strict()).optional() }
const server = z.union([
  z.object({ command: text.min(1), args: z.array(text).max(256).optional(), env: z.record(name, text).optional(), ...fields }).strict(),
  z.object({ url: z.url().max(8192), http_headers: z.record(name, text).optional(), bearer_token_env_var: name.optional(), ...fields }).strict(),
])
const selection = z.record(name, server).refine(value => Object.keys(value).length <= 256 && Buffer.byteLength(JSON.stringify(value)) <= 262144)
export type CodexSelectedMcpServers = z.infer<typeof selection>
export type CodexMcpPolicy = Readonly<{ catalog: CodexConfiguredMcpCatalog; selected: CodexSelectedMcpServers }>
function invalid(): never { throw new Error('codex.mcp.invalid-policy') }
export function captureCodexMcpPolicy(value: CodexMcpPolicy): CodexMcpPolicy {
  try {
    const catalog = captureCodexConfiguredMcpCatalog(value.catalog)
    return Object.freeze({ catalog, selected: structuredClone(selection.parse(value.selected)) })
  } catch { return invalid() }
}
function toml(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') { return JSON.stringify(value) }
  if (Array.isArray(value)) { return '[' + value.map(toml).join(',') + ']' }
  const row = record(value)
  if (!row) { return invalid() }
  return '{' + Object.entries(row).map(([key, field]) => JSON.stringify(key) + '=' + toml(field)).join(',') + '}'
}
/** One top-level inline table avoids native CLI dotted-key splitting for arbitrary server names. */
export function codexMcpPolicyArgs(supplied: CodexMcpPolicy): readonly string[] {
  const policy = captureCodexMcpPolicy(supplied), rows: Record<string, unknown> = { __proto__: null }
  for (const row of policy.catalog.servers) {
    rows[row.name] = { ...(row.transport.type === 'stdio' ? { command: row.transport.command } : { url: row.transport.url }), enabled: false }
  }
  for (const [key, value] of Object.entries(policy.selected)) { rows[key] = { ...value, enabled: true } }
  // The only nonconfigured app-server MCP contributor on this managed no-selected-roots path.
  return Object.freeze(['-c', 'features.apps=false', '-c', 'mcp_servers=' + toml(rows)])
}
/** Codex 0.162 ConfigToml serializes these fields even when the selected TOML omits them. */
function nativeSelectedConfiguration(expected: CodexSelectedMcpServers[string]): Record<string, unknown> {
  return { ...expected, environment_id: 'local', tool_timeout_sec: expected.tool_timeout_sec ?? null,
    ...('command' in expected ? { args: expected.args ?? [] } : {}) }
}
/** Check the effective native merged configuration BEFORE thread allocation can initialize servers. */
export function codexMcpConfigurationMatches(value: unknown, supplied: CodexMcpPolicy): boolean {
  try {
    const policy = captureCodexMcpPolicy(supplied), config = record(record(value)?.config), rows = record(config?.mcp_servers)
    if (!rows || record(config?.features)?.apps !== false) { return false }
    const known = new Set([...policy.catalog.servers.map(row => row.name), ...Object.keys(policy.selected)])
    if (Object.keys(rows).length !== known.size || Object.keys(rows).some(key => !known.has(key))) { return false }
    for (const [key, raw] of Object.entries(rows)) {
      const row = record(raw)
      if (!row) { return false }
      const expected = Object.hasOwn(policy.selected, key) ? policy.selected[key] : undefined
      if (!expected) { if (row.enabled !== false) { return false }; continue }
      const { enabled, ...configuration } = row
      if (enabled !== true || !isDeepStrictEqual(configuration, nativeSelectedConfiguration(expected))) { return false }
    }
    return true
  } catch { return false }
}
/** Scoped policy cannot accept arbitrary native config/runtime root selectors on thread/resume/turn. */
export function managedCodexMcpParameters(thread: Readonly<Record<string, unknown>>, turn: Readonly<Record<string, unknown>>, capabilities: Readonly<Record<string, unknown>> = {}): boolean {
  return Object.keys(thread).every(key => ['cwd', 'model', 'modelProvider', 'approvalPolicy', 'sandbox', 'developerInstructions', 'serviceTier'].includes(key)) &&
    Object.keys(turn).every(key => key === 'effort') && Object.keys(capabilities).every(key => key === 'experimentalApi')
}
