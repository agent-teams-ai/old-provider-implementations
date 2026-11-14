import { CodexProtocolError } from './rpc-types.ts'
import { record } from './wire-frames.ts'

type Position = Readonly<{ line: number; column: number }>
type Range = Readonly<{ start: Position; end: Position }>

/** Private facts for the original connection owner, never conversation or readiness evidence. */
export type CodexConnectionNotification =
  | Readonly<{
    kind: 'config-warning'
    summary: string
    details?: string | null
    path?: string | null
    range?: Range | null
  }>
  | Readonly<{
    kind: 'remote-control-status'
    installationId: string
    serverName: string
    status: 'disabled' | 'connecting' | 'connected' | 'errored'
    environmentId?: string | null
  }>

const invalid = () => new CodexProtocolError('codex.protocol.invalid-connection-notification')
const MAX_TEXT = 8192

function object(value: unknown, keys: readonly string[], required: readonly string[]): Record<string, unknown> {
  const row = record(value)
  if (!row || Object.keys(row).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(row, key))) { throw invalid() }
  return row
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT || value.includes('\0')) { throw invalid() }
  return value
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value)
}

function coordinate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) { throw invalid() }
  return value
}

function position(value: unknown): Position {
  const row = object(value, ['line', 'column'], ['line', 'column'])
  return Object.freeze({ line: coordinate(row.line), column: coordinate(row.column) })
}

function range(value: unknown): Range | null {
  if (value === null) { return null }
  const row = object(value, ['start', 'end'], ['start', 'end'])
  return Object.freeze({ start: position(row.start), end: position(row.end) })
}

/** Unknown methods retain their original dispatcher; malformed known native facts seal the original RPC. */
export function decodeCodexConnectionNotification(method: string, params: unknown): CodexConnectionNotification | undefined {
  if (method === 'configWarning') {
    const row = object(params, ['summary', 'details', 'path', 'range'], ['summary'])
    return Object.freeze({
      kind: 'config-warning',
      summary: text(row.summary),
      ...(Object.hasOwn(row, 'details') ? { details: nullableText(row.details) } : {}),
      ...(Object.hasOwn(row, 'path') ? { path: nullableText(row.path) } : {}),
      ...(Object.hasOwn(row, 'range') ? { range: range(row.range) } : {}),
    })
  }
  if (method === 'remoteControl/status/changed') {
    const row = object(params, ['installationId', 'serverName', 'status', 'environmentId'], ['installationId', 'serverName', 'status'])
    const status = row.status
    if (status !== 'disabled' && status !== 'connecting' && status !== 'connected' && status !== 'errored') { throw invalid() }
    return Object.freeze({
      kind: 'remote-control-status',
      installationId: text(row.installationId),
      serverName: text(row.serverName),
      status,
      ...(Object.hasOwn(row, 'environmentId') ? { environmentId: nullableText(row.environmentId) } : {}),
    })
  }
  return undefined
}
