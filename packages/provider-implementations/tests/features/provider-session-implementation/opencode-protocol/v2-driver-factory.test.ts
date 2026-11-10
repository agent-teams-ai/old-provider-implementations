import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parse, sep } from 'node:path'
import { isCanonicalV2DriverDirectory, snapshotDriverConfig } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-driver-config.ts'
import type { DriverFactory, OpenConfig } from '@agent-teams/provider-session-contracts'
import { createOpenCodeV2DriverFactory } from '../../../../src/opencode.ts'
import { nativeConfig } from './v2-driver-support.ts'
import { driverPeer } from './v2-driver-peer.ts'
import { artifact, attachedInput } from '../provider-session-io/attachment-support.ts'

const request: OpenConfig = { tenantId: 'TEST-tenant', projectId: 'TEST-project', sessionId: 'TEST-runtime-session', generation: 1,
  configRevision: 'TEST-r1', requiredCapabilities: ['text'] }

test('V2 refuses malformed checkpoint references before invoking Host storage or native admission', async t => {
  const host = await driverPeer(); t.after(host.close)
  let resolutions = 0, reads = 0, probes = 0, stringifications = 0
  const factory = createOpenCodeV2DriverFactory({
    capabilities: ['text', 'checkpoint'],
    resolveConfiguration: async () => {
      resolutions++
      const config = nativeConfig(host)
      config.probe = async () => { probes++; return true }
      return config
    },
    readCheckpoint: async () => { reads++; return undefined },
  })
  const coercible = { toString: () => { stringifications++; return 'TEST-forged' } }
  for (const checkpointRef of [null, 0, coercible, ['TEST-forged'], '', '\0', 'x'.repeat(4097), '🚀'.repeat(1500)]) {
    await assert.rejects(factory.open({ ...request, checkpointRef } as unknown as OpenConfig),
      /opencode.driver.invalid-config/)
  }
  assert.equal(resolutions, 0)
  assert.equal(reads, 0)
  assert.equal(probes, 0)
  assert.equal(stringifications, 0)
  assert.equal(host.counts().submitted, 0)
})

test('V2 Host getters cannot swap native authority between validation and config snapshot', async t => {
  const host = await driverPeer(); t.after(host.close)
  const original = nativeConfig(host), supplied = { ...original }
  let sessionReads = 0, endpointReads = 0, versionReads = 0
  Object.defineProperty(supplied, 'nativeSessionId', {
    enumerable: true, get: () => ++sessionReads === 1 ? original.nativeSessionId : 'ses_TESTforeign',
  })
  Object.defineProperty(supplied, 'endpoint', {
    enumerable: true, get: () => ++endpointReads === 1 ? original.endpoint : 'http://127.0.0.1:65535',
  })
  Object.defineProperty(supplied, 'version', {
    enumerable: true, get: () => ++versionReads === 1 ? '2.0.21' : '2.1.4',
  })
  const captured = snapshotDriverConfig(supplied, request)
  assert.equal(captured.nativeSessionId, original.nativeSessionId)
  assert.equal(captured.endpoint, original.endpoint)
  assert.equal(captured.version, '2.0.21')
  assert.deepEqual([sessionReads, endpointReads, versionReads], [1, 1, 1])
  assert.deepEqual(host.counts(), { submitted: 0, interrupted: 0, replies: 0 })
})

test('V2 attachment refs explicitly reject known not sent instead of silently using text queue', async t => {
  const host = await driverPeer(); t.after(host.close)
  const { driver } = await createOpenCodeV2DriverFactory({ capabilities: ['text'], resolveConfiguration: async () => nativeConfig(host), readCheckpoint: async () => {} }).open(request)
  try {
    assert.deepEqual(await driver.submit(attachedInput([artifact().reference])), { ok: false, code: 'unsupported', delivery: 'known-not-sent' })
    assert.equal(host.counts().submitted, 0)
  } finally { await driver.close() }
})

test('V2 native path validation accepts canonical Windows drives but rejects unsafe forms', () => {
  assert.equal(isCanonicalV2DriverDirectory('/TEST/owned/workspace', 'posix'), true)
  for (const path of ['/', '/TEST/../other', '/TEST/owned/', 'TEST/relative']) {
    assert.equal(isCanonicalV2DriverDirectory(path, 'posix'), false, path)
  }
  assert.equal(isCanonicalV2DriverDirectory('C:\\TEST\\owned\\workspace', 'win32'), true)
  for (const path of [
    'C:TEST\\relative', 'C:\\', 'C:\\TEST\\owned\\..\\other',
    'C:\\TEST\\owned\\', 'C:\\TEST\\trailing.', 'C:\\TEST\\trailing ',
    'C:\\TEST\\PRN.txt', 'C:\\TEST\\COM1', 'C:\\TEST\\file:stream',
    '\\\\server\\share\\TEST', '\\TEST\\current-drive', 'C:/TEST/forward',
  ]) {
    assert.equal(isCanonicalV2DriverDirectory(path, 'win32'), false, path)
  }
  assert.equal(isCanonicalV2DriverDirectory(['C:\\TEST\\owned'], 'win32'), false)
  assert.equal(isCanonicalV2DriverDirectory('C:\\TEST\\' + '\0' + 'owned', 'win32'), false)
})

test('selected native factory refuses unsupported capability before resolving Host or performing HTTP', async t => {
  const host = await driverPeer(); t.after(host.close)
  let resolutions = 0
  const factory: DriverFactory = createOpenCodeV2DriverFactory({ capabilities: ['text'], resolveConfiguration: async () => { resolutions++; return nativeConfig(host) }, readCheckpoint: async () => {} })
  await assert.rejects(factory.open({ ...request, requiredCapabilities: ['question'] }), /opencode.driver.unsupported/)
  assert.equal(resolutions, 0); assert.equal(host.counts().submitted, 0)
})

test('native factory validates full runtime generation binding and explicit checkpoint, never replacing missing native identity', async t => {
  const host = await driverPeer(); t.after(host.close)
  const c = nativeConfig(host); let checkpoint: unknown, observed: OpenConfig | undefined
  const factory: DriverFactory = createOpenCodeV2DriverFactory({ capabilities: ['text', 'checkpoint'], resolveConfiguration: async selected => { observed = selected; return c }, readCheckpoint: async () => checkpoint })
  await assert.rejects(factory.open({ ...request, generation: 2 }), /invalid-config/)
  await assert.rejects(factory.open({ ...request, checkpointRef: 'TEST-missing' }), /checkpoint-missing/)
  const first = await factory.open(request)
  assert.ok(Object.isFrozen(observed) && Object.isFrozen(observed?.requiredCapabilities))
  const cp = first.driver.checkpoint(); assert.ok(cp.ok); checkpoint = cp.value
  await first.driver.close()
  // A new owner generation may use the same explicitly selected native binding; no input is replayed.
  c.binding = { ...c.binding, generation: 2 }
  const restored = await factory.open({ ...request, generation: 2, checkpointRef: 'TEST-original' })
  assert.equal(restored.driver.checkpoint().ok, true); await restored.driver.close()
  c.nativeSessionId = 'ses_TESTunrelated'
  await assert.rejects(factory.open({ ...request, generation: 2, checkpointRef: 'TEST-original' }), /checkpoint-incompatible/)
  assert.equal(host.counts().submitted, 0)
})

test('V2 rejects blank Host authority and invalid loopback ports before any native probe', async t => {
  const host = await driverPeer(); t.after(host.close)
  let probes = 0
  const baseline = nativeConfig(host)
  const cases = [
    { trustedBinding: ' \t ' }, { accountBinding: '   ' },
    // A forged trim() result previously admitted a non-string Host identity;
    // checkpoint JSON would serialize these functions as an empty object.
    { trustedBinding: { trim: () => 'TEST-forged' } },
    { accountBinding: { trim: () => 'TEST-forged' } },
    { endpoint: 'http://127.0.0.1:0' },
    { endpoint: 'http://127.0.0.1:00080' },
    { endpoint: 'http://127.0.0.1:65536' },
    { endpoint: 'http://127.0.0.1:99999' },
    // Regex.exec would coerce a one-element JSON array to an approved URL.
    { endpoint: [baseline.endpoint] },
    { directory: 'relative/TEST' },
  ]
  for (const invalid of cases) {
    const factory = createOpenCodeV2DriverFactory({ capabilities: ['text'],
      resolveConfiguration: async () => ({ ...baseline, ...invalid,
        probe: async () => { probes++; return true } } as unknown as ReturnType<typeof nativeConfig>), readCheckpoint: async () => {} })
    await assert.rejects(factory.open(request), /opencode.driver.invalid-config/, JSON.stringify(invalid))
  }
  assert.equal(probes, 0)
  assert.equal(host.counts().submitted, 0)
})

test('V2 rejects root, noncanonical directories and corrupted nested Host bindings before probe', async t => {
  const host = await driverPeer(); t.after(host.close)
  const baseline = nativeConfig(host)
  let probes = 0
  const cases = [
    { directory: parse(baseline.directory).root },
    { directory: baseline.directory + sep + '..' + sep + 'TEST-neighbor' },
    { directory: baseline.directory + sep + sep + 'TEST-duplicate' },
    { directory: baseline.directory + sep },
    { binding: null },
    { limits: null },
  ]
  for (const invalid of cases) {
    const factory = createOpenCodeV2DriverFactory({
      capabilities: ['text'],
      resolveConfiguration: async () => ({
        ...baseline, ...invalid, probe: async () => { probes++; return true },
      } as unknown as ReturnType<typeof nativeConfig>),
      readCheckpoint: async () => {},
    })
    await assert.rejects(factory.open(request), /opencode.driver.invalid-config/, JSON.stringify(invalid))
  }
  assert.equal(probes, 0)
  assert.equal(host.counts().submitted, 0)
})

test('unqualified 2.1.4 Host version is refused before native credentials or probe', async t => {
  const host = await driverPeer(); t.after(host.close)
  let probes = 0; let passwordReads = 0
  const config = { ...nativeConfig(host), version: '2.1.4',
    probe: async () => { probes++; return true },
    readPassword: () => { passwordReads++; return 'TEST-should-never-be-read' },
  } as unknown as ReturnType<typeof nativeConfig>
  const factory = createOpenCodeV2DriverFactory({
    capabilities: ['text'], resolveConfiguration: async () => config, readCheckpoint: async () => {},
  })
  await assert.rejects(factory.open(request), /opencode.driver.invalid-config/)
  assert.equal(probes, 0); assert.equal(passwordReads, 0)
  assert.deepEqual(host.counts(), { submitted: 0, interrupted: 0, replies: 0 })
})

test('private Host failures never project credential/configuration details into public open errors', async () => {
  const factory: DriverFactory = createOpenCodeV2DriverFactory({ capabilities: ['text'], resolveConfiguration: async () => { throw new Error('TEST-private-credential') },
    readCheckpoint: async () => {} })
  await assert.rejects(factory.open(request), error => {
    assert.ok(error instanceof Error); assert.equal(error.message, 'opencode.driver.invalid-config'); return true
  })
})

test('V2 Host probe and physical stop attestation require primitive true, not truthy values', async t => {
  const host = await driverPeer(); t.after(host.close)
  for (const version of ['2.0.0', '2.0.21'] as const) {
    for (const untyped of [1, 'true', { ok: false }, { ok: true }]) {
      let probes = 0, passwordReads = 0
      const config = { ...nativeConfig(host), version,
        probe: async () => { probes++; return untyped as unknown as boolean },
        readPassword: () => { passwordReads++; return 'TEST-private' },
      }
      const factory = createOpenCodeV2DriverFactory({ capabilities: ['text'],
        resolveConfiguration: async () => config, readCheckpoint: async () => {} })
      await assert.rejects(factory.open(request), /opencode.driver.dependency-unavailable/)
      assert.equal(probes, 1, 'one failed Host admission probe')
      assert.equal(passwordReads, 0, 'no native credentials after invalid owner admission')
      assert.equal(host.counts().submitted, 0)
    }
    for (const untyped of [1, 'true', { stopped: false }, { stopped: true }]) {
      let stops = 0
      const config = { ...nativeConfig(host), version,
        confirmStopped: async () => { stops++; return untyped as unknown as boolean },
      }
      const factory = createOpenCodeV2DriverFactory({ capabilities: ['text'],
        resolveConfiguration: async () => config, readCheckpoint: async () => {} })
      const { driver } = await factory.open(request)
      assert.deepEqual(await driver.close(), { logicallyClosed: true, cleanup: 'unknown' },
        'truthy non-boolean cannot certify physical process custody')
      assert.equal(stops, 1)
      assert.equal(host.counts().submitted, 0)
    }
    const validConfig = nativeConfig(host)
    validConfig.version = version
    const positive = createOpenCodeV2DriverFactory({ capabilities: ['text'],
      resolveConfiguration: async () => validConfig, readCheckpoint: async () => {} })
    const { driver } = await positive.open(request)
    assert.deepEqual(await driver.close(), { logicallyClosed: true, cleanup: 'confirmed' })
  }
})

test('V2 rejects nonprimitive revision and runtime bindings before owner probe or credentials', async t => {
  const host = await driverPeer(); t.after(host.close)
  let probes = 0, passwordReads = 0
  for (const version of ['2.0.0', '2.0.21'] as const) {
    for (const field of ['configRevision', 'tenantId', 'projectId', 'sessionId', 'generation'] as const) {
      // A shared object previously passed strict equality and could forge
      // its checkpoint identity through JSON.stringify/toJSON.
      const forged = { toJSON: () => field === 'generation' ? 1 : 'TEST-forged' }
      const supplied = { ...request, [field]: forged } as unknown as OpenConfig
      const baseline = nativeConfig(host)
      const config = {
        ...baseline, version,
        configRevision: field === 'configRevision' ? forged : baseline.configRevision,
        binding: field === 'configRevision' ? baseline.binding : { ...baseline.binding, [field]: forged },
        probe: async () => { probes++; return true },
        readPassword: () => { passwordReads++; return 'TEST-private' },
      } as unknown as ReturnType<typeof nativeConfig>
      const factory = createOpenCodeV2DriverFactory({
        capabilities: ['text'], resolveConfiguration: async () => config, readCheckpoint: async () => {},
      })
      await assert.rejects(factory.open(supplied), /opencode.driver.invalid-config/, `${version}:${field}`)
    }
  }
  assert.equal(probes, 0)
  assert.equal(passwordReads, 0)
  assert.equal(host.counts().submitted, 0)
})
