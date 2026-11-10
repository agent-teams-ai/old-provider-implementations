// V2 exposes opaque native IDs; only safe bounded URL segments may cross the
// private Host/session transport boundary. Official IDs use ses_/msg_ prefixes.
const segment = /^[A-Za-z0-9_-]{1,256}$/

export function safeV2SessionID(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('ses_') && segment.test(value.slice(4))
}
export function safeV2MessageID(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('msg_') && segment.test(value.slice(4))
}

// Pinned V2 permission requests use `per` IDs; only this namespace may be
// addressed by session-bound native permission read/reply routes.
export function safeV2PermissionID(value: unknown): value is string {
  return typeof value === 'string' && /^per[A-Za-z0-9_-]{1,253}$/.test(value)
}
