import { createHash } from 'node:crypto'
import { AttachmentFailure } from '../provider-session-io/attachments.ts'
import type { PreparedAttachment } from '../provider-session-io/attachments.ts'
import { canonicalExecutionJSON } from './v2-canonical-json.ts'
import { record } from './v2-projection-helpers.ts'

export const V2_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export const V2_MEDIA_MIMES = [...V2_IMAGE_MIMES, 'application/pdf'] as const
const MiB = 1024 * 1024
export const V2_IMAGE_BYTES = 4 * MiB
export const V2_IMAGE_TOTAL_BYTES = 8 * MiB
export const V2_MEDIA_COUNT = 5
const nativePdfBase64Bytes = Math.ceil(V2_IMAGE_BYTES / 3) * 4
// Native 2.1.4 normalizes each image to at most 5 MiB of base64. The source
// product budget is smaller, but a compressed large image can expand on resize.
const nativeImageBase64Bytes = 5 * MiB
const envelopeBytes = 6 * 256 * 1024 + 64 * 1024
export const V2_MEDIA_PROMPT_BYTES = Math.ceil(V2_IMAGE_TOTAL_BYTES / 3) * 4 + V2_MEDIA_COUNT * 4 + envelopeBytes
// At most five files in total. PDFs retain their source bytes; only images can
// expand to the native normalized base64 ceiling.
const nativePayloadBytes = Math.max(...Array.from({ length: V2_MEDIA_COUNT + 1 }, (_, images) =>
  images * nativeImageBase64Bytes + Math.min((V2_MEDIA_COUNT - images) * nativePdfBase64Bytes,
    Math.ceil(V2_IMAGE_TOTAL_BYTES / 3) * 4 + (V2_MEDIA_COUNT - images) * 4)))
export const V2_MEDIA_FRAME_BYTES = nativePayloadBytes + envelopeBytes
// A native log contains both the queued payload and its delivered user message.
export const V2_MEDIA_RESPONSE_BYTES = 2 * V2_MEDIA_FRAME_BYTES + 8 * MiB
export const V2_MEDIA_CUT_BYTES = 4 * V2_MEDIA_RESPONSE_BYTES
export const V2_MEDIA_REVISION = 'opencode-2.1.4-native-media-v1'
export const V2_MEDIA_RECEIPT_HEADER = 'x-agent-teams-media-receipt'
export const V2_MEDIA_DEADLINE_HEADER = 'x-agent-teams-media-deadline'

export type V2InlineMedia = Readonly<{ uri: string; name: string }>
export type OpenCodeV2MediaReceipt = Readonly<{
  revision: typeof V2_MEDIA_REVISION
  /** The original packaged child alone attests source -> native normalized bytes. */
  verify(input: Readonly<{
    sessionId: string; inputId: string; sourceDigest: string; projectionDigest: string; witness: string
  }>): boolean
}>

function mime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf'
  return undefined
}
function mediaBytes(uri: unknown): Buffer {
  if (typeof uri !== 'string' || uri.length > Math.ceil(V2_IMAGE_BYTES / 3) * 4 + 32) throw new AttachmentFailure('backpressure')
  const matched = /^data:(image\/(?:png|jpeg|gif|webp)|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri)
  if (!matched) throw new AttachmentFailure('unsupported')
  const bytes = Buffer.from(matched[2]!, 'base64')
  if (!bytes.length || bytes.toString('base64') !== matched[2] || mime(bytes) !== matched[1]) throw new AttachmentFailure('unsupported')
  if (bytes.length > V2_IMAGE_BYTES) throw new AttachmentFailure('backpressure')
  return bytes
}
export function snapshotV2InlineMedia(value: unknown): readonly V2InlineMedia[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > V2_MEDIA_COUNT) throw new AttachmentFailure('unsupported')
  let total = 0
  const files = value.map(entry => {
    const row = record(entry)
    if (!row || Object.keys(row).sort().join(',') !== 'name,uri' || typeof row.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/.test(row.name)) throw new AttachmentFailure('unsupported')
    const bytes = mediaBytes(row.uri)
    total += bytes.length
    return Object.freeze({ uri: row.uri as string, name: row.name })
  })
  if (total > V2_IMAGE_TOTAL_BYTES || new Set(files.map(file => file.name)).size !== files.length) throw new AttachmentFailure('backpressure')
  return Object.freeze(files)
}
export function serializeV2MediaAttachments(attachments: readonly PreparedAttachment[]): readonly V2InlineMedia[] {
  return snapshotV2InlineMedia(attachments.map(item => {
    if (!(V2_MEDIA_MIMES as readonly string[]).includes(item.reference.mimeType) ||
      item.bytes.byteLength !== item.reference.byteLength || createHash('sha256').update(item.bytes).digest('hex') !== item.reference.digest) {
      throw new AttachmentFailure('invalid-config')
    }
    return { uri: `data:${item.reference.mimeType};base64,${Buffer.from(item.bytes).toString('base64')}`, name: item.reference.artifactId }
  }))
}
/** Validate the complete normalized native payload before accepting its attestation. */
export function nativeV2MediaDigest(value: unknown, original: readonly V2InlineMedia[]): string {
  if (!Array.isArray(value) || value.length !== original.length) throw new Error('native_media_projection_mismatch')
  for (const [index, entry] of value.entries()) {
    const row = record(entry), source = record(row?.source)
    const originalFile = original[index]!
    const document = originalFile.uri.startsWith('data:application/pdf;')
    if (!row || Object.keys(row).sort().join(',') !== 'data,mime,name,source' ||
      row.name !== original[index]?.name || !source || Object.keys(source).join(',') !== 'type' || source.type !== 'inline' ||
      typeof row.mime !== 'string' || (document ? row.mime !== 'application/pdf' : !(V2_IMAGE_MIMES as readonly string[]).includes(row.mime)) ||
      typeof row.data !== 'string' || row.data.length > (document ? nativePdfBase64Bytes : nativeImageBase64Bytes) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(row.data)) throw new Error('native_media_projection_mismatch')
    const bytes = Buffer.from(row.data, 'base64')
    if (bytes.toString('base64') !== row.data || mime(bytes) !== row.mime ||
      document && row.data !== originalFile.uri.slice('data:application/pdf;base64,'.length)) throw new Error('native_media_projection_mismatch')
  }
  return createHash('sha256').update(canonicalExecutionJSON(value)).digest('hex')
}

export function snapshotV2MediaReceipt(source: OpenCodeV2MediaReceipt | undefined): OpenCodeV2MediaReceipt | undefined {
  if (source === undefined) return undefined
  const revision = source.revision, verify = source.verify
  if (revision !== V2_MEDIA_REVISION || typeof verify !== 'function') throw new AttachmentFailure('invalid-config')
  return Object.freeze({ revision, verify: (input: Parameters<typeof verify>[0]) => Reflect.apply(verify, source, [Object.freeze({ ...input })]) === true })
}
