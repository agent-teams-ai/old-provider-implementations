/** Finite wire contracts only; Host still qualifies the selected engine bytes and custody. */
export const v2ExecutionVersions = ['2.0.0', '2.0.21', '2.1.4'] as const
export type V2ExecutionVersion = typeof v2ExecutionVersions[number]
export function isV2ExecutionVersion(value: unknown): value is V2ExecutionVersion {
  return typeof value === 'string' && (v2ExecutionVersions as readonly string[]).includes(value)
}
