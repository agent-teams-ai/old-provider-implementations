// TEST-only child-custody regression: exercise the real MCP stdio child without
// the SDK. No credentials, real projects, network requests or production Host.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./native-v2-mcp-proof.mjs', import.meta.url))
async function observeMarker(marker, method) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(marker)) {
      try {
        const value = JSON.parse(readFileSync(marker, 'utf8'))
        if (value?.method === method) return value
      } catch { /* A concurrent, incomplete marker write is not proof. */ }
    }
    await delay(50)
  }
  throw new Error('TEST_MCP_child_boot_marker_not_observed')
}
async function checkChild(initialize) {
  const root = mkdtempSync(join(tmpdir(), 'TEST-mcp-boot-'))
  const marker = join(root, 'child.json')
  const env = { TEST_MCP_CHILD_MARKER: marker,
    PATH: process.env.PATH ?? '',
    ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
  const child = spawn(process.execPath, [script, '--mcp-child'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk.toString('utf8') })
  try {
    const startup = await observeMarker(marker, 'spawn')
    assert.equal(startup.pid, child.pid)
    if (initialize) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\\n')
      const handshake = await observeMarker(marker, 'initialize')
      assert.equal(handshake.pid, child.pid)
    } else {
      // No MCP initialize was sent: a child existed, but no handshake occurred.
      assert.equal(JSON.parse(readFileSync(marker, 'utf8')).method, 'spawn')
    }
    child.stdin.end()
    const code = await Promise.race([exited, delay(5000).then(() => 'timeout')])
    assert.equal(code, 0)
    if (initialize) assert.match(output, /"protocolVersion":"2025-11-25"/)
  } finally {
    if (child.exitCode === null) child.kill()
    await Promise.race([exited.catch(() => {}), delay(2000)])
    rmSync(root, { recursive: true, force: true })
  }
}
test('MCP child records owned process before initialize', () => checkChild(false))
test('MCP child upgrades same marker after real initialize', () => checkChild(true))
