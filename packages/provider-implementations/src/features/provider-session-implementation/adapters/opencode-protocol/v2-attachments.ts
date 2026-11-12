import { createHash } from 'node:crypto'
import { AttachmentFailure } from '../provider-session-io/attachments.ts'
import type { PreparedAttachment } from '../provider-session-io/attachments.ts'
import { canonicalExecutionJSON } from './v2-canonical-json.ts'
import { record } from './v2-projection-helpers.ts'

export type V2InlinePng = Readonly<{ uri: string; name: string }>
// Leave space for native event metadata within the existing 256 KiB SSE frame.
export const V2_PNG_PROMPT_BYTES = 192 * 1024
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function pngBytes(uri: unknown): Buffer {
  if (typeof uri !== 'string' || uri.length > V2_PNG_PROMPT_BYTES ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(uri)) throw new AttachmentFailure('unsupported')
  const base64 = uri.slice('data:image/png;base64,'.length), bytes = Buffer.from(base64, 'base64')
  // Native 2.1.4 preserves PNG bytes below its 2000px normalization threshold.
  if (bytes.toString('base64') !== base64 || bytes.length < 33 ||
      !bytes.subarray(0, 8).equals(signature) || bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      ![bytes.readUInt32BE(16), bytes.readUInt32BE(20)].every(size => size > 0 && size <= 2000)) {
    throw new AttachmentFailure('unsupported')
  }
  return bytes
}
export function snapshotV2InlinePngs(value: unknown): readonly V2InlinePng[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) throw new AttachmentFailure('unsupported')
  const files = value.map(entry => {
    const row = record(entry)
    if (!row || Object.keys(row).sort().join(',') !== 'name,uri' ||
        typeof row.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/.test(row.name)) {
      throw new AttachmentFailure('unsupported')
    }
    pngBytes(row.uri)
    return Object.freeze({ uri: row.uri as string, name: row.name })
  })
  if (new Set(files.map(file => file.name)).size !== files.length ||
      Buffer.byteLength(JSON.stringify(files)) > V2_PNG_PROMPT_BYTES) throw new AttachmentFailure('backpressure')
  return Object.freeze(files)
}
export function serializeV2PngAttachments(attachments: readonly PreparedAttachment[]): readonly V2InlinePng[] {
  return snapshotV2InlinePngs(attachments.map(item => {
    if (item.reference.mimeType !== 'image/png' || item.bytes.byteLength !== item.reference.byteLength ||
        createHash('sha256').update(item.bytes).digest('hex') !== item.reference.digest) {
      throw new AttachmentFailure('invalid-config')
    }
    return { uri: 'data:image/png;base64,' + Buffer.from(item.bytes).toString('base64'), name: item.reference.artifactId }
  }))
}
export function nativeV2PngDigest(files: readonly V2InlinePng[]): string {
  return createHash('sha256').update(canonicalExecutionJSON(files.map(file => ({
    data: file.uri.slice('data:image/png;base64,'.length), mime: 'image/png', source: { type: 'inline' }, name: file.name,
  })))).digest('hex')
}
export function matchesNativeV2Pngs(value: unknown, expected: string): boolean {
  try { return /^[a-f0-9]{64}$/.test(expected) &&
    createHash('sha256').update(canonicalExecutionJSON(value)).digest('hex') === expected }
  catch { return false }
}
