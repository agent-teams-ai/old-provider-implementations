// TEST-only defense in depth: refuse public artifacts with raw native errors,
// runner paths, or credential material. Do not echo unsafe content in diagnostics.
import { readFileSync, readdirSync } from 'node:fs'

const filenames = readdirSync('.').filter(name =>
  name.startsWith('native-v2-') && name.endsWith('.json'))
// A job without a receipt is not evidence. Do not publish unrelated files
// (including package locks) when the native proof crashed before writing JSON.
const expectedProof = process.env.OPENCODE_V2_EXPECTED_TEST_PROOF
const acceptedProofs = new Set([
  'lifecycle', 'model', 'embedded', 'embedded-model', 'embedded-interrupt',
  'embedded-mcp', 'embedded-target-mcp', 'embedded-floor', 'embedded-target',
  'embedded-target-model', 'embedded-target-tool', 'embedded-pinned-tool',
])
const expectedFilename = expectedProof === 'lifecycle'
  ? 'native-v2-readonly-proof.json'
  : expectedProof === 'model'
    ? 'native-v2-model-candidate.json'
    : `native-v2-${expectedProof}-proof.json`
const unsafeKeys = new Set([
  'stack', 'stderr', 'stdout', 'detail', 'message', 'headers', 'authorization',
  'password', 'apikey', 'token', 'raw',
])
// Reject newly added fields carrying credentials, including nested snake_case and camelCase.
// Keep sessionAuthorization (a non-secret TEST assertion) valid.
const unsafeKeyPattern = /(?:secret|password|passphrase|credential|api[_-]?key|private[_-]?key|(?:access|refresh|id)[_-]?token|cookie)/i
const unsafeValue = /(?:\/home\/|\/Users\/|\/tmp\/|\/private\/var\/folders\/|\/var\/folders\/|[A-Za-z]:\\(?:a|Users|Windows)\\|node:internal\/|file:\/\/|\bError:\s|\bBearer\s+\S+|\bBasic\s+[A-Za-z0-9+/=]{16,}|\bsk-[A-Za-z0-9_-]{12,}|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b)/i
const unsafeWindowsPath = /(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+|(?<!:)\/\/[^\\/\s]+[\\/][^\\/\s]+)/
let unsafe = 0
if (!acceptedProofs.has(expectedProof) || filenames.length !== 1 || filenames[0] !== expectedFilename) unsafe++
function inspect(value) {
  if (typeof value === 'string') {
    if (unsafeValue.test(value) || unsafeWindowsPath.test(value)) unsafe++
  } else if (Array.isArray(value)) {
    value.forEach(inspect)
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      // The existing lifecycle receipt reports a bounded *count*, never a secret.
      const safeCredentialCounter = key === 'ownCredentialReads' &&
        Number.isSafeInteger(entry) && entry >= 0
      if (!safeCredentialCounter && (unsafeKeys.has(key.toLowerCase()) || unsafeKeyPattern.test(key))) unsafe++
      inspect(entry)
    }
  }
}
for (const filename of filenames) {
  try {
    const proof = JSON.parse(readFileSync(filename, 'utf8'))
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) unsafe++
    else {
      if (proof.qualified !== false) unsafe++
      inspect(proof)
    }
  } catch {
    unsafe++
  }
}
if (unsafe > 0) {
  console.error(`TEST_native_receipt_safety_rejected count=${unsafe}`)
  process.exitCode = 1
} else {
  console.log(`TEST_native_receipts_safe count=${filenames.length}`)
}
