import { setTimeout as delay } from 'node:timers/promises'
import { CodexProtocolError } from './rpc-types.ts'
import { record, string } from './wire-frames.ts'

export type RequiredMcpTools = Readonly<Record<string, readonly string[]>>
export type CodexMcpServerStatus = {
  readonly name: string
  readonly authStatus: 'unknown' | 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth'
  readonly runtimeStatus: 'notStarted' | 'starting' | 'connected' | 'authenticationRequired' | 'failed' | 'cancelled' | 'disabled' | null
  readonly toolsError: string | null
  readonly tools: Readonly<Record<string, { readonly name: string }>>
}
export type CodexMcpServerStatusPage = { readonly data: readonly CodexMcpServerStatus[]; readonly nextCursor: string | null }
export type CodexMcpStatusRequest = { readonly threadId: string; readonly serverName?: string; readonly cursor?: string; readonly limit?: number }

const invalid = (): never => { throw new CodexProtocolError('codex.protocol.invalid-mcp-status') }
function boundedName(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096 }
export function captureMcpStatusRequest(request: CodexMcpStatusRequest): CodexMcpStatusRequest {
  if (!boundedName(request.threadId) || (request.serverName !== undefined && !boundedName(request.serverName)) ||
    (request.cursor !== undefined && !boundedName(request.cursor)) ||
    (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1000))) { throw new CodexProtocolError('codex.protocol.invalid-mcp-status-request', 'not-sent') }
  return { threadId: request.threadId, ...(request.serverName === undefined ? {} : { serverName: request.serverName }),
    ...(request.cursor !== undefined ? { cursor: request.cursor } : {}), limit: request.limit ?? 100 }
}
export function captureRequiredMcpTools(value: RequiredMcpTools): RequiredMcpTools {
  const fields = record(value)
  if (!fields || Object.keys(fields).length > 64) { return invalid() }
  const prototype: unknown = Object.getPrototypeOf(fields)
  if (prototype !== Object.prototype && prototype !== null) { return invalid() }
  return Object.freeze(Object.fromEntries(Object.entries(fields).map(([server, tools]) => {
    if (!boundedName(server) || !Array.isArray(tools) || !tools.length || tools.length > 256 ||
      !tools.every(boundedName) || new Set(tools).size !== tools.length) { return invalid() }
    return [server, Object.freeze([...tools])]
  })))
}
function decodeStatus(value: unknown): CodexMcpServerStatus {
  const row = record(value), tools = record(row?.tools)
  const name = string(row?.name)
  if (name === null || name.length === 0 || !boundedName(name) || !tools || Object.keys(tools).length > 4096 || !Array.isArray(row?.resources) || !Array.isArray(row.resourceTemplates) ||
    typeof row.authStatus !== 'string' || !['unknown', 'unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'].includes(row.authStatus)) { return invalid() }
  const runtimeStatus = row.runtimeStatus ?? null, toolsError = row.toolsError ?? null
  if ((runtimeStatus !== null && (typeof runtimeStatus !== 'string' || !['notStarted', 'starting', 'connected', 'authenticationRequired', 'failed', 'cancelled', 'disabled'].includes(runtimeStatus))) ||
    (toolsError !== null && typeof toolsError !== 'string')) { return invalid() }
  const entries = Object.entries(tools).map(([key, tool]) => {
    const fields = record(tool)
    if (!boundedName(key) || !fields || !boundedName(fields.name) || !Object.hasOwn(fields, 'inputSchema')) { return invalid() }
    return [key, { name: fields.name }] as const
  })
  return { name, authStatus: row.authStatus as CodexMcpServerStatus['authStatus'], runtimeStatus: runtimeStatus as CodexMcpServerStatus['runtimeStatus'], toolsError, tools: Object.fromEntries(entries) }
}
/** Pinned 0.162 response projection; no arbitrary native payload enters readiness. */
export function decodeMcpStatusPage(value: unknown): CodexMcpServerStatusPage {
  const page = record(value)
  if (!page || !Array.isArray(page.data) || page.data.length > 1000 || (page.nextCursor !== undefined && page.nextCursor !== null && !boundedName(page.nextCursor))) { return invalid() }
  const data = page.data.map(decodeStatus)
  if (new Set(data.map(row => row.name)).size !== data.length) { return invalid() }
  return { data, nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null }
}
type StatusClient = { listMcpServerStatus: (request: CodexMcpStatusRequest, signal?: AbortSignal) => Promise<CodexMcpServerStatusPage> }
async function serverStatus(client: StatusClient, threadId: string, serverName: string, signal: AbortSignal): Promise<CodexMcpServerStatus | undefined> {
  const cursors = new Set<string>(); let cursor: string | undefined, status: CodexMcpServerStatus | undefined
  for (let page = 0; page < 16; page++) {
    signal.throwIfAborted()
    const response = await client.listMcpServerStatus({ threadId, serverName, ...(cursor !== undefined ? { cursor } : {}), limit: 100 }, signal)
    for (const row of response.data) {
      if (row.name !== serverName || status !== undefined) { return invalid() }
      status = row
    }
    if (response.nextCursor === null) { return status }
    if (cursors.has(response.nextCursor)) { return invalid() }
    cursors.add(response.nextCursor); cursor = response.nextCursor
  }
  return invalid()
}
export async function requiredMcpToolsReady(client: StatusClient, threadId: string, required: RequiredMcpTools, signal: AbortSignal): Promise<boolean> {
  for (const [server, tools] of Object.entries(required)) {
    while (!signal.aborted) {
      const status = await serverStatus(client, threadId, server, signal)
      if (!status) { return false }
      if (status.runtimeStatus === 'notStarted' || status.runtimeStatus === 'starting') { await delay(20, undefined, { signal }); continue }
      if (status.runtimeStatus !== 'connected' || status.toolsError !== null || !tools.every(tool => Object.hasOwn(status.tools, tool) && status.tools[tool]?.name === tool)) { return false }
      break
    }
    signal.throwIfAborted()
  }
  return !signal.aborted
}

type ExactPolicyFloor = Readonly<{ selected: readonly string[]; disabled: readonly string[]; required: RequiredMcpTools }>
type ExactPolicy = { selected: Set<string>; disabled: Set<string>; required: RequiredMcpTools }
type PolicyState = 'invalid' | 'waiting' | 'ready'
function policyServerState(row: CodexMcpServerStatus, policy: ExactPolicy): PolicyState {
  if (!policy.selected.has(row.name)) {
    return policy.disabled.has(row.name) && (row.runtimeStatus === 'disabled' || row.runtimeStatus === null) && Object.keys(row.tools).length === 0 ? 'ready' : 'invalid'
  }
  if (row.runtimeStatus === 'starting' || row.runtimeStatus === 'notStarted') { return 'waiting' }
  if (row.runtimeStatus !== 'connected' || row.toolsError !== null) { return 'invalid' }
  const expected = Object.hasOwn(policy.required, row.name) ? policy.required[row.name] : undefined
  return expected && (Object.keys(row.tools).length !== expected.length || !expected.every(tool => row.tools[tool]?.name === tool)) ? 'invalid' : 'ready'
}
/** One complete bounded census pass; no subset or duplicate page can qualify. */
async function policyPass(client: StatusClient, threadId: string, policy: ExactPolicy, signal: AbortSignal): Promise<PolicyState> {
  const seen = new Set<string>(), cursors = new Set<string>()
  let cursor: string | undefined, waiting = false
  for (let page = 0; page < 16; page++) {
    signal.throwIfAborted()
    const response = await client.listMcpServerStatus({ threadId, ...(cursor === undefined ? {} : { cursor }), limit: 100 }, signal)
    for (const row of response.data) {
      const state = policyServerState(row, policy)
      if (seen.has(row.name) || state === 'invalid') { return 'invalid' }
      seen.add(row.name)
      waiting ||= state === 'waiting'
    }
    if (response.nextCursor === null) {
      if (![...policy.selected].every(name => seen.has(name))) { return 'invalid' }
      return waiting ? 'waiting' : 'ready'
    }
    if (cursors.has(response.nextCursor)) { return 'invalid' }
    cursors.add(response.nextCursor); cursor = response.nextCursor
  }
  return 'invalid'
}
/** Entire native active catalog. Disabled captured rows may be omitted by native projection. */
export async function exactMcpPolicyReady(client: StatusClient, threadId: string, floor: ExactPolicyFloor, signal: AbortSignal): Promise<boolean> {
  const selected = new Set(floor.selected), disabled = new Set(floor.disabled)
  if (selected.size !== floor.selected.length || disabled.size !== floor.disabled.length || floor.disabled.some(name => selected.has(name)) || Object.keys(floor.required).some(name => !selected.has(name))) { return false }
  const policy = { selected, disabled, required: floor.required }
  while (!signal.aborted) {
    const state = await policyPass(client, threadId, policy, signal)
    if (state !== 'waiting') { return state === 'ready' }
    await delay(20, undefined, { signal })
  }
  return false
}
