import { CodexProtocolError } from './rpc-types.ts'
import { record } from './wire-frames.ts'

export type CodexAccountLoginType = 'chatgpt' | 'chatgptDeviceCode'
/** Private native presentation. The caller owns its audience, lifetime and browser opening. */
export type CodexAccountLoginStart =
  | { readonly type: 'chatgpt'; readonly loginId: string; readonly authUrl: string }
  | { readonly type: 'chatgptDeviceCode'; readonly loginId: string; readonly verificationUrl: string; readonly userCode: string }
/** A native fact, not account/custody proof. A null ID cannot settle an owned login. */
export type CodexAccountLoginCompleted = {
  readonly loginId: string | null
  readonly success: boolean
  readonly error: string | null
}
/** notFound does not prove cancellation, logout or process cleanup. */
export type CodexAccountLoginCancel = { readonly status: 'canceled' | 'notFound' }

const invalid = () => new CodexProtocolError('codex.protocol.invalid-login-response')
const badRequest = () => new CodexProtocolError('codex.protocol.invalid-login-request', 'not-sent')
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) { throw invalid() }
  return value
}
function authorizationUrl(value: unknown): string {
  const supplied = text(value, 8192)
  let url: URL
  try { url = new URL(supplied) } catch { throw invalid() }
  if (url.protocol !== 'https:' || url.username || url.password) { throw invalid() }
  return url.toString()
}

export function captureAccountLoginType(type: CodexAccountLoginType): CodexAccountLoginType {
  if (type !== 'chatgpt' && type !== 'chatgptDeviceCode') { throw badRequest() }
  return type
}
export function captureAccountLoginId(loginId: string): string {
  try { return text(loginId, 2048) } catch { throw badRequest() }
}
export function decodeAccountLoginStart(value: unknown, type: CodexAccountLoginType): CodexAccountLoginStart {
  const row = record(value)
  if (!row || row.type !== type) { throw invalid() }
  const loginId = text(row.loginId, 2048)
  return type === 'chatgpt'
    ? { type, loginId, authUrl: authorizationUrl(row.authUrl) }
    : { type, loginId, verificationUrl: authorizationUrl(row.verificationUrl), userCode: text(row.userCode, 256).trim() }
}
export function decodeAccountLoginCompleted(row: Record<string, unknown>): CodexAccountLoginCompleted {
  if (typeof row.success !== 'boolean' || (row.error !== null && row.error !== undefined && typeof row.error !== 'string')) { throw invalid() }
  const error = row.error ?? null
  if (typeof error === 'string' && (error.length > 8192 || error.includes('\0'))) { throw invalid() }
  return {
    loginId: row.loginId === null || row.loginId === undefined ? null : text(row.loginId, 2048),
    success: row.success,
    error: typeof error === 'string' ? error : null,
  }
}
export function decodeAccountLoginCancel(value: unknown): CodexAccountLoginCancel {
  const row = record(value)
  if (!row || (row.status !== 'canceled' && row.status !== 'notFound')) { throw invalid() }
  return { status: row.status }
}
