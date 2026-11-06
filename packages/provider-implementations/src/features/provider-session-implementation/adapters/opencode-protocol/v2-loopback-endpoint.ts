/** One fail-closed admission rule for all publicly constructible V2 wires.
 * The type guard is important: RegExp.exec coerces JSON arrays to strings.
 * Keep the same lexical/port boundary at the Host snapshot and raw read/control APIs.
 */
export function isCanonicalOpenCodeV2LoopbackEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const port = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value)?.[1]
  return port !== undefined && Number(port) <= 65535
}
