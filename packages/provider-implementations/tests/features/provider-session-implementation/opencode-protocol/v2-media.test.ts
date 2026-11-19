import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { Event } from '@agent-teams/provider-session-contracts'
import { createOpenCodeV2DriverFactory, createOpenCodeV2ExecutionTransport } from '../../../../src/opencode.ts'
import { snapshotV2InlineMedia, serializeV2MediaAttachments, nativeV2MediaDigest, V2_IMAGE_MIMES,
  V2_MEDIA_MIMES, V2_MEDIA_REVISION, V2_MEDIA_RECEIPT_HEADER } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-media.ts'
import { canonicalExecutionJSON } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-canonical-json.ts'
import { attachmentPort, attachedInput } from '../provider-session-io/attachment-support.ts'
import { nativeConfig } from './v2-driver-support.ts'
import { driverPeer } from './v2-driver-peer.ts'
import type { OpenCodeV2DriverConfig } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-driver-config.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=', 'base64')
const pdf = Buffer.from('%PDF-1.7\n1 0 obj <</Type/Catalog>> endobj\n%%EOF\n')
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
function item(bytes: Buffer, mimeType = 'image/png', artifactId = 'TEST-image') {
  return { bytes: Buffer.from(bytes), reference: { artifactId, mimeType, byteLength: bytes.length, digest: digest(bytes) } }
}
const inline = (image: ReturnType<typeof item>) => ({ name: image.reference.artifactId,
  uri: `data:${image.reference.mimeType};base64,${image.bytes.toString('base64')}` })
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) { assert.ok(Date.now() < deadline, 'TEST media observation deadline'); await delay(10) }
}
async function fixture(images = [item(png)], normalize = false) {
  const peer = await driverPeer(normalize ? { normalizeImages: files => files.map(file => ({ ...file, data: png.toString('base64'), mime: 'image/png' })) } : {})
  const attest = (value: Omit<Parameters<NonNullable<OpenCodeV2DriverConfig['mediaReceipt']>['verify']>[0], 'witness'>) =>
    'v1.' + (Date.now() + 10_000) + '.' + createHmac('sha256', 'TEST-only-native-owner').update(JSON.stringify(value)).digest('hex')
  let verifications = 0
  const witnesses = new Map<string, string>()
  const config: OpenCodeV2DriverConfig = { ...nativeConfig(peer), version: '2.1.4',
    attachments: attachmentPort('TEST-provider/TEST-model', images), mediaReceipt: { revision: V2_MEDIA_REVISION,
      verify(value) {
        verifications++
        const { witness, ...proof } = value
        return witnesses.get(JSON.stringify(proof)) === witness
      } },
    fetchImpl: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const body = request.method === 'POST' ? await request.clone().text() : undefined
      const response = await fetch(input, init)
      if (!body || !request.url.endsWith('/prompt')) return response
      const sent = JSON.parse(body) as { id: string; files?: unknown[] }
      if (!sent.files) return response
      const received = await response.json() as { data: { payload: { files: unknown[] } } }
      const proof = { sessionId: peer.sessionId, inputId: sent.id, sourceDigest: digest(body),
        projectionDigest: digest(canonicalExecutionJSON(received.data.payload.files)) }
      const witness = attest(proof); witnesses.set(JSON.stringify(proof), witness)
      return new Response(JSON.stringify(received), { status: 200,
        headers: { 'content-type': 'application/json', [V2_MEDIA_RECEIPT_HEADER]: witness } })
    } }
  const request = { ...config.binding, configRevision: config.configRevision, requiredCapabilities: ['text', 'attachments'] }
  const makeFactory = (checkpoint?: unknown) => createOpenCodeV2DriverFactory({ capabilities: ['text', 'attachments', 'checkpoint'],
    resolveConfiguration: async () => config, readCheckpoint: async () => checkpoint })
  return { peer, config, request, makeFactory, verifications: () => verifications }
}

test('private media admits image and PDF signatures at 4 MiB/file and 8 MiB total', () => {
  const images = [item(png), item(Buffer.from([255, 216, 255, 0]), 'image/jpeg', 'TEST-jpeg'),
    item(Buffer.from('GIF89aTEST'), 'image/gif', 'TEST-gif'), item(Buffer.from('RIFFTESTWEBP'), 'image/webp', 'TEST-webp'), item(pdf, 'application/pdf', 'TEST-pdf')]
  assert.deepEqual(serializeV2MediaAttachments(images), images.map(inline))
  assert.equal(snapshotV2InlineMedia(images.map(inline)).length, 5)
  assert.throws(() => snapshotV2InlineMedia([...images, item(pdf, 'application/pdf', 'TEST-sixth')].map(inline)))
  for (const [bytes, mime] of [[png, 'image/png'], [pdf, 'application/pdf']] as const) {
    assert.throws(() => snapshotV2InlineMedia(Array.from({ length: 6 }, (_, i) => inline(item(bytes, mime, `TEST-many${i}`)))))
  }
  const large = Buffer.alloc(4 * 1024 * 1024); png.copy(large)
  assert.equal(snapshotV2InlineMedia([inline(item(large)), inline(item(large, 'image/png', 'TEST-second'))]).length, 2)
  assert.throws(() => snapshotV2InlineMedia([inline(item(large)), inline(item(large, 'image/png', 'TEST-second')), inline(item(png, 'image/png', 'TEST-third'))]))
  assert.throws(() => snapshotV2InlineMedia([inline(item(Buffer.concat([large, Buffer.from([0])])))]))
  assert.throws(() => snapshotV2InlineMedia([inline(item(png, 'image/jpeg'))]))
  assert.throws(() => snapshotV2InlineMedia([{ name: 'TEST-x', uri: 'file:///TEST/image.png' }]))
  assert.throws(() => snapshotV2InlineMedia([{ name: 'TEST-x', uri: 'https://TEST.invalid/image.png' }]))
  assert.throws(() => snapshotV2InlineMedia([{ ...inline(item(png)), uri: inline(item(png)).uri + '=' }]))
  assert.throws(() => serializeV2MediaAttachments([{ ...item(png), bytes: Buffer.alloc(png.length) }]))
  assert.ok(Object.isFrozen(snapshotV2InlineMedia(images.map(inline))))
})

test('verified native normalization binds original bytes, exact ACK and subsequent history without replay', async t => {
  const original = Buffer.from(png); original.writeUInt32BE(2001, 16)
  const image = item(original), f = await fixture([image], true); t.after(f.peer.close)
  const { driver } = await f.makeFactory().open(f.request), events: Event[] = []
  const observed = (async () => { for await (const event of driver.observe()) events.push(event) })()
  try {
    assert.equal((await driver.submit(attachedInput([image.reference]))).ok, true)
    await until(() => events.some(event => event.kind === 'result'))
    assert.equal(events.find(event => event.kind === 'result')?.outcome, 'succeeded')
    assert.equal(f.verifications(), 1); assert.equal(f.peer.counts().submitted, 1)
    const user = [...f.peer.outputs.values()][0]!.messages.data.find(row => row.type === 'user')!
    assert.equal((user.data.files as { data: string }[])[0]!.data, png.toString('base64'))
  } finally { await driver.close(); await observed }
})

test('media-session budget survives a large original image, later text and cold checkpoint reopen', async t => {
  const bytes = Buffer.alloc(3 * 1024 * 1024); png.copy(bytes)
  const pdfBytes = Buffer.alloc(3 * 1024 * 1024); pdf.copy(pdfBytes)
  const images = [item(bytes), item(pdfBytes, 'application/pdf', 'TEST-document')], f = await fixture(images); t.after(f.peer.close)
  // This 6 MiB wire/history case has a finite transfer budget, independent of
  // the shared 4 KiB fixture's 2s deadline; product transport defaults do not change.
  f.config.limits = { ...f.config.limits, timeoutMs: 10_000 }
  let opened = await f.makeFactory().open(f.request), events: Event[] = []
  let observed = (async () => { for await (const event of opened.driver.observe()) events.push(event) })()
  const submitted = await opened.driver.submit(attachedInput(images.map(image => image.reference)))
  assert.equal(submitted.ok, true, JSON.stringify(submitted))
  await until(() => events.filter(event => event.kind === 'result').length === 1)
  assert.equal((await opened.driver.submit(attachedInput([], 2))).ok, true)
  await until(() => events.filter(event => event.kind === 'result').length === 2)
  assert.ok(events.filter(event => event.kind === 'result').every(event => event.outcome === 'succeeded'))
  const checkpoint = opened.driver.checkpoint(); assert.ok(checkpoint.ok)
  await opened.driver.close(); await observed
  opened = await f.makeFactory(checkpoint.value).open({ ...f.request, checkpointRef: 'TEST-media-checkpoint' }); events = []
  observed = (async () => { for await (const event of opened.driver.observe()) events.push(event) })()
  try {
    assert.equal((await opened.driver.submit(attachedInput([], 3))).ok, true)
    await until(() => events.some(event => event.kind === 'result'))
    assert.equal(events.find(event => event.kind === 'result')?.outcome, 'succeeded')
    assert.equal(f.peer.counts().submitted, 3); assert.equal(f.verifications(), 1)
  } finally { await opened.driver.close(); await observed }
})

test('missing, forged or swapped normalized ACK cannot certify success or resend the source', async t => {
  for (const mode of ['missing', 'forged', 'bytes', 'owner'] as const) {
    const image = item(png), f = await fixture([image]); t.after(f.peer.close)
    const original = f.config.fetchImpl!
    f.config.fetchImpl = async (input, init) => {
      const response = await original(input, init)
      if (!(input instanceof Request ? input.url : String(input)).endsWith('/prompt')) return response
      if (mode === 'missing') response.headers.delete(V2_MEDIA_RECEIPT_HEADER)
      if (mode === 'forged') response.headers.set(V2_MEDIA_RECEIPT_HEADER, 'v1.' + (Date.now() + 10_000) + '.' + 'f'.repeat(64))
      if (mode === 'bytes') {
        const value = await response.json() as { data: { payload: { files: { data: string }[] } } }
        value.data.payload.files[0]!.data = Buffer.concat([png, Buffer.from([1])]).toString('base64')
        return new Response(JSON.stringify(value), { headers: response.headers })
      }
      return response
    }
    if (mode === 'owner') f.config.mediaReceipt = { revision: V2_MEDIA_REVISION, verify: () => false }
    const { driver } = await f.makeFactory().open(f.request)
    try {
      assert.deepEqual(await driver.submit(attachedInput([image.reference])), { ok: false, code: 'unknown' })
      assert.equal((await driver.submit(attachedInput([image.reference], 2))).ok, false)
      assert.equal(f.peer.counts().submitted, 1)
    } finally { await driver.close() }
  }
})

test('the public raw wire still rejects files and oversized SSE before exposing media bytes', async () => {
  let calls = 0
  const config = { endpoint: 'http://127.0.0.1:12345', directory: '/TEST/media', nativeSessionId: 'ses_TESTmedia',
    version: '2.1.4' as const, deadline: Date.now() + 5000, readPassword: () => 'TEST-private',
    fetchImpl: async () => { calls++; return new Response('data: ' + JSON.stringify({ text: 'x'.repeat(300 * 1024) }) + '\n\n',
      { headers: { 'content-type': 'text/event-stream' } }) } }
  const raw = createOpenCodeV2ExecutionTransport(config)
  try {
    await assert.rejects(raw.fetch(config.endpoint + '/api/session/ses_TESTmedia/prompt', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'msg_TESTinput', text: 'TEST', resume: true, delivery: 'queue', files: [inline(item(png))] }) }))
    assert.equal(calls, 0)
    await assert.rejects(raw.fetch(config.endpoint + '/api/experimental/session/ses_TESTmedia/log?follow=false'))
    assert.equal(calls, 1)
  } finally { await raw.dispose() }
})

test('normalized digest rejects unsupported video, reordered names and noncanonical native bytes', () => {
  const originals = [inline(item(png))]
  const file = { name: 'TEST-image', mime: 'image/png', source: { type: 'inline' }, data: png.toString('base64') }
  assert.equal(nativeV2MediaDigest([file], originals), digest(canonicalExecutionJSON([file])))
  for (const altered of [{ ...file, mime: 'video/mp4' }, { ...file, name: 'TEST-foreign' },
    { ...file, data: file.data + '=' }, { ...file, source: { type: 'uri', uri: 'file:///TEST' } }]) {
    assert.throws(() => nativeV2MediaDigest([altered], originals))
  }
  const document = item(pdf, 'application/pdf', 'TEST-pdf'), originalPdf = [inline(document)]
  const nativePdf = { name: 'TEST-pdf', mime: 'application/pdf', source: { type: 'inline' }, data: pdf.toString('base64') }
  assert.equal(nativeV2MediaDigest([nativePdf], originalPdf), digest(canonicalExecutionJSON([nativePdf])))
  assert.throws(() => nativeV2MediaDigest([{ ...nativePdf, data: Buffer.concat([pdf, Buffer.from('changed')]).toString('base64') }], originalPdf))
  assert.throws(() => nativeV2MediaDigest([{ ...nativePdf, mime: 'image/png', data: png.toString('base64') }], originalPdf))
  assert.deepEqual(V2_IMAGE_MIMES, ['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  assert.deepEqual(V2_MEDIA_MIMES, [...V2_IMAGE_MIMES, 'application/pdf'])
})
