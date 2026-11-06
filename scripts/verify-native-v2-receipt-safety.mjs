// TEST-only defense in depth: refuse public artifacts with raw native errors,
// runner paths, or credential material. Do not echo unsafe content in diagnostics.
import { readFileSync, readdirSync } from 'node:fs'

const filenames = readdirSync('.').filter(name =>
  name.startsWith('native-v2-') && name.endsWith('.json'))
const unsafeKeys = new Set([
  'stack', 'stderr', 'stdout', 'detail', 'message', 'headers', 'authorization',
  'password', 'apikey', 'token', 'raw',
])
const unsafeValue = /(?:\/home\/|\/Users\/|\/tmp\/|\/private\/var\/folders\/|\/var\/folders\/|[A-Za-z]:\\(?:a|Users|Windows)\\|node:internal\/|file:\/\/|\bError:\s|\bBearer\s+\S+|\bBasic\s+[A-Za-z0-9+/=]{16,}|\bsk-[A-Za-z0-9_-]{12,})/i
let unsafe = 0
function inspect(value) {
  if (typeof value === 'string') {
    if (unsafeValue.test(value)) unsafe++
  } else if (Array.isArray(value)) {
    value.forEach(inspect)
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (unsafeKeys.has(key.toLowerCase())) unsafe++
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
