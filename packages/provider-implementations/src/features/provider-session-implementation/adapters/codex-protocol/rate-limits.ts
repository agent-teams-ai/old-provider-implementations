import { CodexProtocolError } from './rpc-types.ts'
import { record } from './wire-frames.ts'

export interface CodexRateLimitWindow {
  readonly usedPercent: number
  readonly windowDurationMins: number | null
  readonly resetsAt: number | null
}
export interface CodexRateLimitSnapshot {
  readonly limitId: string | null
  readonly limitName: string | null
  readonly primary: CodexRateLimitWindow | null
  readonly secondary: CodexRateLimitWindow | null
  readonly credits: { readonly hasCredits: boolean; readonly unlimited: boolean; readonly balance: string | null } | null
  readonly planType: string | null
}

const invalid = (): never => { throw new CodexProtocolError('codex.protocol.invalid-metadata-response') }
function object(value: unknown): Record<string, unknown> { return record(value) ?? invalid() }
function text(value: unknown): string | null {
  if (value === null || value === undefined) { return null }
  if (typeof value !== 'string' || value.length > 1024 || value.includes('\0')) { return invalid() }
  return value
}
function count(value: unknown): number | null {
  if (value === null || value === undefined) { return null }
  if (!Number.isSafeInteger(value) || Number(value) < 0) { return invalid() }
  return Number(value)
}
function window(value: unknown): CodexRateLimitWindow | null {
  if (value === null || value === undefined) { return null }
  const row = object(value)
  if (typeof row.usedPercent !== 'number' || !Number.isFinite(row.usedPercent) || row.usedPercent < 0 || row.usedPercent > 1_000_000) { return invalid() }
  return { usedPercent: row.usedPercent, windowDurationMins: count(row.windowDurationMins), resetsAt: count(row.resetsAt) }
}
function credits(value: unknown): CodexRateLimitSnapshot['credits'] {
  if (value === null || value === undefined) { return null }
  const row = object(value)
  if (typeof row.hasCredits !== 'boolean' || typeof row.unlimited !== 'boolean') { return invalid() }
  return { hasCredits: row.hasCredits, unlimited: row.unlimited, balance: text(row.balance) }
}

/** One summary only. Arbitrary native bucket maps, private fields and remote diagnostics never escape. */
export function decodeRateLimits(value: unknown): CodexRateLimitSnapshot {
  const row = object(object(value).rateLimits)
  return { limitId: text(row.limitId), limitName: text(row.limitName), primary: window(row.primary),
    secondary: window(row.secondary), credits: credits(row.credits), planType: text(row.planType) }
}
