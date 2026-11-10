import { CodexProtocolError } from './rpc-types.ts'
import { record } from './wire-frames.ts'

/** Native adapter DTOs only. The caller owns account selection, custody and readiness policy. */
export interface CodexRuntimeIdentity {
  readonly codexHome: string
  readonly platformFamily: string
  readonly platformOs: string
}
export interface CodexAccountMetadata {
  readonly account: { readonly type: 'apiKey' } | {
    readonly type: 'chatgpt'; readonly email: string; readonly planType: string
  } | null
  readonly requiresOpenaiAuth: boolean
}
export interface CodexModelListRequest {
  readonly cursor?: string | null
  readonly limit?: number
  readonly includeHidden?: boolean
}
export interface CodexModelMetadata {
  readonly id: string
  readonly model: string
  readonly displayName: string
  readonly description: string | null
  readonly hidden: boolean
  readonly isDefault: boolean
  readonly supportedReasoningEfforts: readonly string[]
  readonly defaultReasoningEffort: string | null
  readonly inputModalities: readonly string[]
  readonly supportsPersonality: boolean
}
export interface CodexModelPage {
  readonly data: readonly CodexModelMetadata[]
  readonly nextCursor: string | null
}
export interface CodexConfigReadRequest {
  readonly cwd?: string
  readonly profile?: string
}
export interface CodexModelConfiguration {
  readonly model: string | null
  readonly modelProvider: string | null
  readonly reasoningEffort: string | null
}

const invalid = () => new CodexProtocolError('codex.protocol.invalid-metadata-response')
const badRequest = () => new CodexProtocolError('codex.protocol.invalid-metadata-request', 'not-sent')
function text(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) { throw invalid() }
  return value
}
function nullableText(value: unknown, max = 2048): string | null {
  return value === null || value === undefined ? null : text(value, max)
}
function object(value: unknown): Record<string, unknown> {
  const result = record(value)
  if (!result) { throw invalid() }
  return result
}
function flag(value: unknown): boolean {
  if (value === undefined) { return false }
  if (typeof value !== 'boolean') { throw invalid() }
  return value
}
function strings(value: unknown, maxItems: number): string[] {
  if (value === undefined) { return [] }
  if (!Array.isArray(value) || value.length > maxItems) { throw invalid() }
  return value.map(entry => text(entry, 128))
}

export function decodeRuntimeIdentity(value: unknown): CodexRuntimeIdentity {
  const row = object(value)
  return { codexHome: text(row.codexHome, 8192), platformFamily: text(row.platformFamily, 128), platformOs: text(row.platformOs, 128) }
}
export function decodeAccountMetadata(value: unknown): CodexAccountMetadata {
  const row = object(value)
  if (typeof row.requiresOpenaiAuth !== 'boolean') { throw invalid() }
  if (row.account === null) { return { account: null, requiresOpenaiAuth: row.requiresOpenaiAuth } }
  const account = object(row.account)
  if (account.type === 'apiKey') { return { account: { type: 'apiKey' }, requiresOpenaiAuth: row.requiresOpenaiAuth } }
  if (account.type !== 'chatgpt') { throw invalid() }
  return { account: { type: 'chatgpt', email: text(account.email, 1024), planType: text(account.planType, 128) }, requiresOpenaiAuth: row.requiresOpenaiAuth }
}
function decodeModel(value: unknown): CodexModelMetadata {
  const row = object(value), id = text(row.id ?? row.model), model = text(row.model ?? id)
  const efforts = row.supportedReasoningEfforts ?? []
  if (!Array.isArray(efforts) || efforts.length > 32) { throw invalid() }
  return {
    id, model, displayName: text(row.displayName ?? model), description: row.description === '' ? '' : nullableText(row.description, 8192),
    hidden: flag(row.hidden), isDefault: flag(row.isDefault),
    supportedReasoningEfforts: efforts.map(entry => text(typeof entry === 'string' ? entry : object(entry).reasoningEffort, 128)),
    defaultReasoningEffort: nullableText(row.defaultReasoningEffort, 128),
    inputModalities: strings(row.inputModalities, 16), supportsPersonality: flag(row.supportsPersonality),
  }
}
export function decodeModelPage(value: unknown, limit: number): CodexModelPage {
  const row = object(value)
  if (!Array.isArray(row.data) || row.data.length > limit) { throw invalid() }
  const data = row.data.map(decodeModel)
  if (new Set(data.map(model => model.id)).size !== data.length) { throw invalid() }
  return { data, nextCursor: nullableText(row.nextCursor, 8192) }
}
export function decodeModelConfiguration(value: unknown): CodexModelConfiguration {
  const config = object(object(value).config)
  return { model: nullableText(config.model), modelProvider: nullableText(config.model_provider), reasoningEffort: nullableText(config.model_reasoning_effort, 128) }
}
function request(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = record(value)
  if (!row || Object.keys(row).some(key => !keys.includes(key))) { throw badRequest() }
  return row
}
export function captureModelListRequest(value: CodexModelListRequest): { cursor: string | null; limit: number; includeHidden: boolean } {
  const row = request(value, ['cursor', 'limit', 'includeHidden'])
  const limit = row.limit ?? 100
  if ((row.limit !== undefined && row.limit === null) || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100 ||
      (row.includeHidden !== undefined && typeof row.includeHidden !== 'boolean') ||
      (row.cursor !== undefined && row.cursor !== null && (typeof row.cursor !== 'string' || !row.cursor || row.cursor.length > 8192 || row.cursor.includes('\0')))) { throw badRequest() }
  return { cursor: typeof row.cursor === 'string' ? row.cursor : null, limit: Number(limit), includeHidden: row.includeHidden === true }
}
export function captureConfigReadRequest(supplied: CodexConfigReadRequest): Record<string, string> {
  const row = request(supplied, ['cwd', 'profile']), result: Record<string, string> = {}
  for (const key of ['cwd', 'profile']) {
    const value = row[key]
    if (value === undefined) { continue }
    if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > (key === 'cwd' ? 8192 : 256)) { throw badRequest() }
    result[key] = value
  }
  return result
}
