import { executionAssert } from './v2-failures.ts'
import { record } from './v2-projection-helpers.ts'

/** Native session metadata only; neither secret bytes nor prompt content. */
export type OpenCodeV2CredentialBinding = Readonly<{ scopeDigest: string; credentialId: string }>
export function readOpenCodeV2CredentialBinding(value: unknown): OpenCodeV2CredentialBinding | undefined {
  if (value === undefined) return undefined
  const row = record(value)
  executionAssert(row !== null && Object.keys(row).toSorted().join(',') === 'credentialId,scopeDigest'
    && typeof row.scopeDigest === 'string' && /^[a-f0-9]{64}$/u.test(row.scopeDigest)
    && typeof row.credentialId === 'string' && /^cred_[A-Za-z0-9]{1,250}$/u.test(row.credentialId),
  'invalid_native_credential_binding')
  return { scopeDigest: row.scopeDigest, credentialId: row.credentialId }
}
