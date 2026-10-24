import { captureCodexMcpPolicy, managedCodexMcpParameters } from './mcp-policy.ts'
import type { CodexMcpPolicy } from './mcp-policy.ts'
import { createHash } from 'node:crypto'
import { snapshotInputWindowPort } from './input-window-capture.ts'
import type { CodexInputWindowPort } from './input-window-capture.ts'
import type { Limits, OpenConfig } from '@agent-teams/provider-session-contracts'
import type { CodexInitializeParams } from './app-server.ts'
import type { CodexAppServerTransport, CodexRpcLimits } from './rpc-types.ts'
import { attachmentCompatibility, snapshotAttachmentPort } from '../provider-session-io/attachments.ts'
import type { AttachmentPort } from '../provider-session-io/attachments.ts'
import { captureRequiredMcpTools } from './mcp-status.ts'
import type { RequiredMcpTools } from './mcp-status.ts'

/** Explicit private binding. The caller owns the connected transport, native process and durable identity. */
export type CodexDriverConfig = {
  readonly binding: Readonly<{ tenantId: string; projectId: string; sessionId: string; generation: number }>
  readonly configRevision: string
  readonly protocolRevision: string
  readonly trustedBinding: string
  readonly accountBinding: string
  readonly transport: CodexAppServerTransport
  readonly initialize: CodexInitializeParams
  readonly threadParams: Readonly<Record<string, unknown>>
  readonly turnParams?: Readonly<Record<string, unknown>>
  readonly attachments?: AttachmentPort
  /** Optional bounded input-window observations; never tool authorization. */
  readonly capture?: CodexInputWindowPort
  /** Required native raw server/tool names, checked against this client's selected thread before work. */
  readonly requiredMcpTools?: RequiredMcpTools
  /** Private exact policy; verifier rechecks the original native source before status can initialize MCP. */
  readonly mcpPolicy?: CodexMcpPolicy
  readonly verifyMcpCatalog?: (signal: AbortSignal) => Promise<boolean>
  readonly rpcLimits?: Partial<CodexRpcLimits>
  readonly limits: Limits
  /** Read-only qualification of this exact configuration and custody, not ambient discovery. */
  readonly probe: (signal: AbortSignal) => Promise<boolean>
  /** Caller confirms owned native work/process cleanup. Local protocol close alone cannot prove it. */
  readonly confirmStopped: () => Promise<boolean>
}

// Host objects are structural ports, not JSON records: retain class, callable
// and inherited implementations while validating the properties we consume.
function configurationFields(value: unknown): Record<string, unknown> | null {
  return value !== null && (typeof value === 'object' || typeof value === 'function') ? value as Record<string, unknown> : null
}
function matchingBinding(binding: unknown, request: OpenConfig): boolean {
  const fields = configurationFields(binding)
  return fields !== null && ['tenantId', 'projectId', 'sessionId', 'generation'].every(key => fields[key] === request[key as keyof typeof request])
}
function validLimits(limits: unknown): boolean {
  const fields = configurationFields(limits)
  return fields !== null && ['queuedInputs', 'inputBytes', 'outputBytes', 'outputEvents', 'pendingInteractions', 'timeoutMs'].every(key => {
    const value = fields[key]
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
  })
}
function configuredClient(config: Record<string, unknown>): boolean {
  const transport = configurationFields(config.transport), initialize = configurationFields(config.initialize), client = configurationFields(initialize?.clientInfo)
  return transport !== null && typeof transport.read === 'function' && typeof transport.write === 'function'
    && client !== null && typeof client.name === 'string' && client.name.length > 0 && typeof client.version === 'string' && client.version.length > 0
}
function validDriverConfiguration(value: unknown, request: OpenConfig): boolean {
  const config = configurationFields(value)
  if (config === null) {return false}
  const thread = configurationFields(config.threadParams), turn = config.turnParams === undefined || config.turnParams === null ? {} : configurationFields(config.turnParams)
  return config.configRevision === request.configRevision
    && ['protocolRevision', 'trustedBinding', 'accountBinding'].every(key => typeof config[key] === 'string' && config[key].length > 0)
    && matchingBinding(config.binding, request) && validLimits(config.limits) && configuredClient(config)
    && typeof config.probe === 'function' && typeof config.confirmStopped === 'function'
    && thread !== null && turn !== null && !Object.hasOwn(thread, 'threadId') && !['input', 'threadId'].some(key => Object.hasOwn(turn, key))
}
export function captureDriverConfig(config: CodexDriverConfig, request: OpenConfig): CodexDriverConfig {
  if (!validDriverConfiguration(config, request)) {throw new Error('codex.driver.invalid-config')}
  if (config.mcpPolicy !== undefined && (typeof config.verifyMcpCatalog !== 'function' || !managedCodexMcpParameters(config.threadParams, config.turnParams ?? {}, config.initialize.capabilities))) { throw new Error('codex.driver.invalid-config') }
  const mcpPolicy = config.mcpPolicy === undefined ? undefined : captureCodexMcpPolicy(config.mcpPolicy)
  if (mcpPolicy && Object.keys(config.requiredMcpTools ?? {}).some(server => !Object.hasOwn(mcpPolicy.selected, server))) { throw new Error('codex.driver.invalid-config') }
  const { capture: suppliedCapture, ...base } = config
  const capture = snapshotInputWindowPort(suppliedCapture)
  return { ...base, ...(capture ? { capture } : {}), binding: { ...config.binding }, limits: { ...config.limits }, initialize: structuredClone(config.initialize),
    ...(config.requiredMcpTools !== undefined ? { requiredMcpTools: captureRequiredMcpTools(config.requiredMcpTools) } : {}),
    ...(mcpPolicy !== undefined ? { mcpPolicy, verifyMcpCatalog: config.verifyMcpCatalog!.bind(config) } : {}),
    ...(config.attachments !== undefined ? { attachments: snapshotAttachmentPort(config.attachments)! } : {}),
    threadParams: structuredClone(config.threadParams), turnParams: structuredClone(config.turnParams ?? {}), rpcLimits: { ...config.rpcLimits } }
}

export function driverCompatibility(config: CodexDriverConfig): string {
  const { tenantId, projectId, sessionId } = config.binding
  return createHash('sha256').update(JSON.stringify({ tenantId, projectId, sessionId, configRevision: config.configRevision,
    protocolRevision: config.protocolRevision, trustedBinding: config.trustedBinding, accountBinding: config.accountBinding,
    threadParams: config.threadParams, turnParams: config.turnParams,
    ...(config.attachments ? { attachments: attachmentCompatibility(config.attachments) } : {}),
    ...(config.requiredMcpTools !== undefined ? { requiredMcpTools: config.requiredMcpTools } : {}),
    ...(config.mcpPolicy !== undefined ? { mcpPolicy: config.mcpPolicy } : {}) })).digest('hex')
}

export type CodexDriverCheckpoint = {
  readonly nativeThreadId: string
  readonly itemOwners: readonly (readonly [string, string | null])[]
  readonly legacyItemsExhausted: boolean
}
function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') {return undefined}
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {return undefined}
  const entries = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(entries).some(key => typeof key !== 'string' || !('value' in entries[key]!))) {return undefined}
  return Object.fromEntries(Object.entries(entries).map(([key, descriptor]) => {
    const field: unknown = descriptor.value
    return [key, field]
  }))
}
function plainArray(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {return undefined}
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== value.length + 1 || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !('value' in descriptors[key]!))) {return undefined}
  return Array.from({ length: value.length }, (_, index) => {
    const field: unknown = descriptors[String(index)]!.value
    return field
  })
}
function ownerPair(value: unknown): readonly [string, string | null] {
  if (!Array.isArray(value) || value.length !== 2) {throw new Error('invalid')}
  const pair = plainArray(value)
  if (pair === undefined || pair.length !== 2 || typeof pair[0] !== 'string' || pair[0].length === 0
    || (pair[1] !== null && (typeof pair[1] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pair[1])))) {throw new Error('invalid')}
  return [pair[0], pair[1]]
}
function checkpointItems(value: unknown, limits: Limits): readonly (readonly [string, string | null])[] {
  if (!Array.isArray(value) || value.length > limits.outputEvents) {throw new Error('invalid')}
  const entries = plainArray(value)
  if (entries === undefined) {throw new Error('invalid')}
  const items = new Map<string, string | null>(); let bytes = 0
  for (const raw of entries) {
    const [item, owner] = ownerPair(raw)
    if (items.has(item)) {throw new Error('invalid')}
    bytes += Buffer.byteLength(item) + (owner === null ? 0 : Buffer.byteLength(owner))
    if (bytes > limits.outputBytes) {throw new Error('invalid')}
    items.set(item, owner)
  }
  return [...items]
}
export function selectedDriverCheckpoint(value: unknown, config: CodexDriverConfig): CodexDriverCheckpoint {
  try {
    const checkpoint = plainRecord(value)
    if (!checkpoint || checkpoint.version !== 2 || checkpoint.engine !== 'codex-app-server' || typeof checkpoint.nativeThreadId !== 'string'
      || checkpoint.nativeThreadId.length === 0 || Buffer.byteLength(checkpoint.nativeThreadId) > 4096 || checkpoint.compatibility !== driverCompatibility(config)
      || typeof checkpoint.legacyItemsExhausted !== 'boolean' || Object.keys(checkpoint).toSorted().join(',') !== 'compatibility,engine,itemOwners,legacyItemsExhausted,nativeThreadId,version') {throw new Error('invalid')}
    return { nativeThreadId: checkpoint.nativeThreadId, itemOwners: checkpointItems(checkpoint.itemOwners, config.limits), legacyItemsExhausted: checkpoint.legacyItemsExhausted }
  } catch { throw new Error('codex.driver.checkpoint-incompatible') }
}
