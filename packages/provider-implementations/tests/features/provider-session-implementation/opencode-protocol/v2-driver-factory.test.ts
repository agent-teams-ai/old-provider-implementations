import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DriverFactory, OpenConfig } from '@agent-teams/provider-session-contracts'
import { createOpenCodeV2DriverFactory } from '../../../../src/opencode.ts'
import { nativeConfig } from './v2-driver-support.ts'
import { driverPeer } from './v2-driver-peer.ts'
import { artifact, attachedInput } from '../provider-session-io/attachment-support.ts'

const request: OpenConfig = { tenantId: 'TEST-tenant', projectId: 'TEST-project', sessionId: 'TEST-runtime-session', generation: 1,
  configRevision: 'TEST-r1', requiredCapabilities: ['text'] }

test('V2 attachment refs explicitly reject known not sent instead of silently using text queue', async t => {
  const host = await driverPeer(); t.after(host.close)
  const { driver } = await createOpenCodeV2DriverFactory({ capabilities: ['text'], resolveConfiguration: async () => nativeConfig(host), readCheckpoint: async () => {} }).open(request)
  try {
    assert.deepEqual(await driver.submit(attachedInput([artifact().reference])), { ok: false, code: 'unsupported', delivery: 'known-not-sent' })
    assert.equal(host.counts().submitted, 0)
  } finally { await driver.close() }
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

test('private Host failures never project credential/configuration details into public open errors', async () => {
  const factory: DriverFactory = createOpenCodeV2DriverFactory({ capabilities: ['text'], resolveConfiguration: async () => { throw new Error('TEST-private-credential') },
    readCheckpoint: async () => {} })
  await assert.rejects(factory.open(request), error => {
    assert.ok(error instanceof Error); assert.equal(error.message, 'opencode.driver.invalid-config'); return true
  })
})
