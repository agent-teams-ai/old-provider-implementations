import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { Event } from '@agent-teams/provider-session-contracts'
import { createOpenCodeV2DriverFactory } from '../../../../src/opencode.ts'
import { snapshotV2InlinePngs, serializeV2PngAttachments, nativeV2PngDigest } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-attachments.ts'
import { attachmentPort, attachedInput } from '../provider-session-io/attachment-support.ts'
import { nativeConfig } from './v2-driver-support.ts'
import { driverPeer } from './v2-driver-peer.ts'
import type { OpenCodeV2DriverConfig } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-driver-config.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=', 'base64')
const item = { bytes: png, reference: { artifactId: 'TEST-image', mimeType: 'image/png', byteLength: png.length,
  digest: createHash('sha256').update(png).digest('hex') } }
const files = [{ uri: 'data:image/png;base64,' + png.toString('base64'), name: item.reference.artifactId }]
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000
  while (!predicate()) { assert.ok(Date.now() < deadline, 'TEST attachment observation deadline'); await delay(10) }
}
async function fixture() {
  const peer = await driverPeer(), config: OpenCodeV2DriverConfig & { attachments: NonNullable<OpenCodeV2DriverConfig['attachments']> } = { ...nativeConfig(peer), version: '2.1.4',
    attachments: attachmentPort('TEST-provider/TEST-model', [item]) }
  const request = { ...config.binding, configRevision: config.configRevision, requiredCapabilities: ['text', 'attachments'] }
  const factory = createOpenCodeV2DriverFactory({ capabilities: ['text', 'attachments', 'checkpoint'],
    resolveConfiguration: async () => config, readCheckpoint: async () => undefined })
  return { peer, config, request, factory }
}

test('2.1.4 admits only immutable bounded PNG data URIs with the verified original digest', () => {
  assert.deepEqual(serializeV2PngAttachments([item]), files)
  assert.ok(Object.isFrozen(serializeV2PngAttachments([item])[0]))
  for (const uri of ['file:///TEST/private.png', 'https://TEST.invalid/x', 'data:text/plain;base64,VEVTVA==',
    files[0]!.uri + '\n', files[0]!.uri + '=']) assert.throws(() => snapshotV2InlinePngs([{ uri, name: 'TEST-image' }]))
  for (const value of [[], [...files, ...files], [{ ...files[0], description: 'TEST-extra' }],
    [{ ...files[0], name: '../TEST-foreign' }]]) assert.throws(() => snapshotV2InlinePngs(value))
  const oversized = Buffer.from(png); oversized.writeUInt32BE(2001, 16)
  assert.throws(() => snapshotV2InlinePngs([{ uri: 'data:image/png;base64,' + oversized.toString('base64'), name: 'TEST-image' }]))
  assert.throws(() => serializeV2PngAttachments([{ ...item, bytes: Buffer.alloc(png.length) }]))
  assert.equal(nativeV2PngDigest(files), nativeV2PngDigest(serializeV2PngAttachments([item])))
})

test('2.1.4 Session SPI delivers an original PNG once and requires its exact native ACK and history', async t => {
  const f = await fixture(); t.after(f.peer.close)
  const { driver, capabilities } = await f.factory.open(f.request), events: Event[] = []
  const observed = (async () => { for await (const event of driver.observe()) events.push(event) })()
  try {
    assert.ok(capabilities.includes('attachments'))
    assert.equal((await driver.submit(attachedInput([item.reference]))).ok, true)
    await until(() => events.some(event => event.kind === 'result'))
    assert.equal(events.find(event => event.kind === 'result')?.outcome, 'succeeded')
    assert.equal(f.peer.counts().submitted, 1)
    const original = [...f.peer.outputs.values()][0]!.messages.data.find(row => row.type === 'user')!
    assert.deepEqual(original.data.files, [{ data: png.toString('base64'), mime: 'image/png', source: { type: 'inline' }, name: 'TEST-image' }])
    assert.equal(driver.checkpoint().ok, true)
  } finally { await driver.close(); await observed }
})

test('PNG source bytes, owner binding and selected native model cannot be substituted before submit', async t => {
  for (const kind of ['bytes', 'binding', 'model'] as const) {
    const f = await fixture(); t.after(f.peer.close)
    if (kind === 'model') f.config.attachments = { ...f.config.attachments, model: 'TEST-provider/TEST-foreign' }
    else f.config.attachments = { ...f.config.attachments, resolve: async binding => ({
      binding: kind === 'binding' ? { ...binding, operationRef: 'TEST-foreign' } : binding,
      bytes: kind === 'bytes' ? Buffer.alloc(png.length) : png,
    }) }
    const { driver } = await f.factory.open(f.request)
    try {
      const result = await driver.submit(attachedInput([item.reference]))
      assert.equal(result.ok, false); if (!result.ok) assert.equal(result.delivery, 'known-not-sent')
      assert.equal(f.peer.counts().submitted, 0)
    } finally { await driver.close() }
  }
})

test('attachment Host getters cannot replace the captured model, policy or original receiver callback', async t => {
  const f = await fixture(); t.after(f.peer.close)
  const original = f.config.attachments
  const reads = { model: 0, revision: 0, mimeTypes: 0, resolve: 0 }, receiver = {}
  let resolutions = 0
  const resolve: typeof original.resolve = async function(this: unknown, binding, signal) {
    assert.equal(this, receiver); resolutions++; return original.resolve(binding, signal)
  }
  Object.defineProperty(resolve, 'name', { get() { throw new Error('TEST callable name must not be read') } })
  Object.defineProperties(receiver, {
    model: { get: () => ++reads.model === 1 ? original.model : 'TEST-swapped/model' },
    revision: { get: () => ++reads.revision === 1 ? original.revision : 'TEST-swapped-policy' },
    mimeTypes: { get: () => ++reads.mimeTypes === 1 ? original.mimeTypes : ['image/jpeg'] },
    resolve: { get: () => ++reads.resolve === 1 ? resolve : async () => { throw new Error('TEST replacement resolver') } },
  })
  f.config.attachments = receiver as typeof original
  const { driver } = await f.factory.open(f.request), events: Event[] = []
  const observed = (async () => { for await (const event of driver.observe()) events.push(event) })()
  try {
    assert.equal((await driver.submit(attachedInput([item.reference]))).ok, true)
    await until(() => events.some(event => event.kind === 'result'))
    assert.equal(events.find(event => event.kind === 'result')?.outcome, 'succeeded')
    assert.deepEqual(reads, { model: 1, revision: 1, mimeTypes: 1, resolve: 1 })
    assert.equal(resolutions, 1); assert.equal(f.peer.counts().submitted, 1)
  } finally { await driver.close(); await observed }
})

test('changed PNG ACK remains UNKNOWN and cannot replay the native input', async t => {
  const f = await fixture(); t.after(f.peer.close)
  f.config.fetchImpl = async (input, init) => {
    const result = await fetch(input, init)
    if (!(input instanceof Request ? input.url : String(input)).endsWith('/prompt')) return result
    const body = await result.json() as { data: { payload: { files: { name: string }[] } } }
    body.data.payload.files[0]!.name = 'TEST-foreign'
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const { driver } = await f.factory.open(f.request)
  try {
    assert.deepEqual(await driver.submit(attachedInput([item.reference])), { ok: false, code: 'unknown' })
    assert.equal((await driver.submit(attachedInput([item.reference], 2))).ok, false)
    assert.equal(f.peer.counts().submitted, 1)
  } finally { await driver.close() }
})

test('old dialect, non-PNG policy and changed attachment checkpoint policy refuse before native admission', async t => {
  const f = await fixture(); t.after(f.peer.close)
  for (const version of ['2.0.0', '2.0.21'] as const) {
    const factory = createOpenCodeV2DriverFactory({ capabilities: ['text', 'attachments'],
      resolveConfiguration: async () => ({ ...f.config, version }), readCheckpoint: async () => undefined })
    await assert.rejects(factory.open(f.request), /invalid-config/)
  }
  const { driver } = await f.factory.open(f.request)
  const checkpoint = driver.checkpoint(); assert.ok(checkpoint.ok)
  await driver.close()
  for (const attachments of [{ ...f.config.attachments, mimeTypes: ['image/jpeg'] },
    { ...f.config.attachments, revision: 'TEST-new-policy' }]) {
    let probes = 0
    const factory = createOpenCodeV2DriverFactory({ capabilities: ['text', 'attachments'],
      resolveConfiguration: async () => ({ ...f.config, attachments, probe: async () => { probes++; return true } }),
      readCheckpoint: async () => checkpoint.value })
    await assert.rejects(factory.open({ ...f.request, checkpointRef: 'TEST-checkpoint' }))
    assert.equal(probes, 0)
  }
  assert.equal(f.peer.counts().submitted, 0)
})
