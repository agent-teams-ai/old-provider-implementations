// Focused fail-closed tests for public native TEST artifact admission.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./verify-native-v2-receipt-safety.mjs', import.meta.url))
const valid = JSON.stringify({ qualified: false, completed: true, cleanup: true })

function check(proof, files) {
  const cwd = mkdtempSync(join(tmpdir(), 'v2-receipt-safety-'))
  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(cwd, name), contents)
    }
    const result = spawnSync(process.execPath, [script], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, OPENCODE_V2_EXPECTED_TEST_PROOF: proof },
    })
    assert.equal(result.error, undefined)
    return result.status
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

test('accepts one clean receipt for the selected matrix proof', () => {
  assert.equal(check('embedded-target-mcp', {
    'native-v2-embedded-target-mcp-proof.json': valid,
  }), 0)
  assert.equal(check('lifecycle', {
    'native-v2-readonly-proof.json': valid,
  }), 0)
})

test('rejects absent, mismatched or extra receipts', () => {
  assert.equal(check('embedded-target-mcp', {}), 1)
  assert.equal(check('embedded-target-mcp', {
    'native-v2-embedded-proof.json': valid,
  }), 1)
  assert.equal(check('embedded-target-mcp', {
    'native-v2-embedded-target-mcp-proof.json': valid,
    'native-v2-embedded-proof.json': valid,
  }), 1)
})

test('rejects unsupported matrix proof and missing proof selector', () => {
  assert.equal(check('unknown', {
    'native-v2-unknown-proof.json': valid,
  }), 1)
  assert.equal(check('', {
    'native-v2-embedded-proof.json': valid,
  }), 1)
})

test('rejects unqualified or unsafe native error receipts', () => {
  assert.equal(check('embedded', {
    'native-v2-embedded-proof.json': JSON.stringify({ qualified: true }),
  }), 1)
  assert.equal(check('embedded', {
    'native-v2-embedded-proof.json': JSON.stringify({
      qualified: false, failure: 'Error: /home/runner/private-key',
    }),
  }), 1)
})

// A native SDK upgrade must not turn newly named fields or recognizable
// provider tokens into public evidence, even if older receipts were safe.
test('rejects nested credential-like keys and recognizable token values', () => {
  for (const data of [
    { access_token: 'redacted' },
    { clientSecret: 'redacted' },
    { nested: { refreshToken: 'redacted' } },
    { credentials: { arbitrary: 'redacted' } },
    { sessionAuthorization: { verified: true }, trace: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    { trace: 'github_pat_abcdefghijklmnopqrstuvwxyz0123456789' },
    { trace: 'AKIA0123456789ABCDEF' },
    { trace: 'D:\\TEST\\private-session\\config.json' },
    { trace: '\\\\internal-server\\private-share\\session.json' },
  ]) {
    assert.equal(check('embedded', {
      'native-v2-embedded-proof.json': JSON.stringify({ qualified: false, ...data }),
    }), 1)
  }
})


test('rejects slash-normalized Windows drive and UNC paths in public receipts', () => {
  for (const location of [
    'E:/TEST/private-session/config.json',
    '//internal-server/private-share/session.json',
    String.raw`\\internal-server/private-share/session.json`,
  ]) {
    assert.equal(check('embedded', {
      'native-v2-embedded-proof.json': JSON.stringify({ qualified: false, trace: location }),
    }), 1)
  }
})

test('ordinary non-secret URL metadata is not mistaken for a Windows drive path', () => {
  assert.equal(check('embedded', {
    'native-v2-embedded-proof.json': JSON.stringify({ qualified: false, origin: 'http://127.0.0.1:12345' }),
  }), 0)
})

test('does not reject safe Session authority assertion metadata', () => {
  assert.equal(check('embedded', {
    'native-v2-embedded-proof.json': JSON.stringify({
      qualified: false, sessionAuthorization: { verified: true },
    }),
  }), 0)
})

test('accepts native lifecycle credential-read counter but not a string payload', () => {
  assert.equal(check('lifecycle', {
    'native-v2-readonly-proof.json': JSON.stringify({
      qualified: false, nativeIdleInterrupt: { ownCredentialReads: 1 },
    }),
  }), 0)
  assert.equal(check('lifecycle', {
    'native-v2-readonly-proof.json': JSON.stringify({
      qualified: false, nativeIdleInterrupt: { ownCredentialReads: 'redacted' },
    }),
  }), 1)
})
