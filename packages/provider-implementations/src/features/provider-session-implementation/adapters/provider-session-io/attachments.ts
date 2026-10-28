import { createHash } from 'node:crypto';
import type { FailureCode, Input } from '@agent-teams/provider-session-contracts';
import { bounded } from './io.ts';

type Reference = NonNullable<Input['attachments']>[number];
type Binding = { readonly trustedBinding: string; readonly sessionRef: string; readonly inputId: string; readonly operationRef: string; readonly fingerprint: string; readonly reference: Reference };
export type AttachmentPort = {
  /** Exact Host-approved selected model and policy revision; product recipient/model policy stays in Host. */
  readonly model: string; readonly revision: string; readonly mimeTypes: readonly string[];
  readonly resolve: (request: Binding, signal: AbortSignal) => Promise<{
    readonly binding: Binding; readonly bytes: Uint8Array;
    /** Consumer guarantees these exact verified bytes remain at this owned path until terminal/recovery. */
    readonly nativePath?: string;
  } | undefined>;
};
export type PreparedAttachment = { readonly reference: Reference; readonly bytes: Uint8Array; readonly nativePath?: string };
export class AttachmentFailure extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) { super('attachment-' + code); this.code = code; }
}
function attachmentRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && (typeof value === 'object' || typeof value === 'function') ? value as Record<string, unknown> : undefined;
}
export function snapshotAttachmentPort(port: AttachmentPort | undefined): AttachmentPort | undefined {
  if (port === undefined) { return undefined; }
  const raw = attachmentRecord(port);
  const mimeTypes: unknown = raw?.mimeTypes;
  if (raw === undefined || typeof raw.model !== 'string' || raw.model.length === 0 || typeof raw.revision !== 'string' || raw.revision.length === 0 ||
    !Array.isArray(mimeTypes) || !mimeTypes.every((mime: unknown): mime is string => typeof mime === 'string' && mime.length > 0 && mime.length <= 128) || typeof raw.resolve !== 'function') {
    throw new AttachmentFailure('invalid-config');
  }
  return { model: raw.model, revision: raw.revision, mimeTypes: [...mimeTypes], resolve: port.resolve.bind(port) };
}
export function attachmentCompatibility(port: AttachmentPort | undefined): unknown {
  return port && { model: port.model, revision: port.revision, mimeTypes: port.mimeTypes };
}
export function snapshotInput(input: Input): Input {
  if (input.attachments === undefined) { return { ...input }; }
  if (!Array.isArray(input.attachments) || input.attachments.length > 11) { throw new AttachmentFailure('invalid-config'); }
  const references: readonly unknown[] = input.attachments;
  const attachments = references.map(raw => {
    const ref = attachmentRecord(raw);
    if (ref === undefined || typeof ref.artifactId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/.test(ref.artifactId) ||
      typeof ref.mimeType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(ref.mimeType) || ref.mimeType.length > 128 ||
      typeof ref.byteLength !== 'number' || !Number.isSafeInteger(ref.byteLength) || ref.byteLength <= 0 || typeof ref.digest !== 'string' || !/^[a-f0-9]{64}$/.test(ref.digest)) {
      throw new AttachmentFailure('invalid-config');
    }
    return Object.freeze({ artifactId: ref.artifactId, mimeType: ref.mimeType, byteLength: ref.byteLength, digest: ref.digest });
  });
  if (new Set(attachments.map(ref => ref.artifactId)).size !== attachments.length) { throw new AttachmentFailure('invalid-config'); }
  return { ...input, attachments: Object.freeze(attachments) };
}
export function inputFingerprint(input: Input): string {
  return createHash('sha256').update(JSON.stringify([input.content, (input.attachments ?? []).map(ref => [ref.artifactId, ref.mimeType, ref.byteLength, ref.digest])])).digest('hex');
}
export function validCanonicalInput(input: Input, maxBytes: number): boolean {
  return typeof input.inputId === 'string' && !!input.inputId && Buffer.byteLength(input.inputId) <= 4096 &&
    typeof input.operationRef === 'string' && !!input.operationRef && Buffer.byteLength(input.operationRef) <= 4096 &&
    typeof input.content === 'string' && !!input.content.trim() && Buffer.byteLength(input.content) <= maxBytes;
}
function sameBinding(actual: Binding | undefined, expected: Binding): boolean {
  const binding = attachmentRecord(actual), reference = attachmentRecord(binding?.reference);
  return binding !== undefined && reference !== undefined &&
    (['trustedBinding', 'sessionRef', 'inputId', 'operationRef', 'fingerprint'] as const).every(key => binding[key] === expected[key]) &&
    (['artifactId', 'mimeType', 'byteLength', 'digest'] as const).every(key => reference[key] === expected.reference[key]);
}
type Provider = 'claude' | 'codex' | 'opencode-v1' | 'opencode-v2';
function nativeKind(mime: string, provider: Provider): 'image' | 'file' | 'video' | undefined {
  if (provider === 'opencode-v2') { return undefined; }
  if (['image/png', 'image/jpeg', 'image/webp'].includes(mime) || (provider === 'claude' && mime === 'image/gif')) { return 'image'; }
  if (provider === 'claude' && (mime === 'application/pdf' || mime.startsWith('text/'))) { return 'file'; }
  if (provider === 'opencode-v1' && ['video/mp4', 'video/webm', 'video/quicktime'].includes(mime)) { return 'video'; }
  return undefined;
}
export function validateAttachments(input: Input, provider: Provider, model: string | undefined, port?: AttachmentPort): void {
  const refs = input.attachments ?? []; if (!refs.length) { return; }
  if (!port || port.model !== model) { throw new AttachmentFailure('unsupported'); }
  const counts = { image: 0, file: 0, video: 0 }; let total = 0;
  for (const ref of refs) {
    const kind = nativeKind(ref.mimeType, provider);
    if (!kind || !port.mimeTypes.some(mime => mime === ref.mimeType || (mime === 'text/*' && ref.mimeType.startsWith('text/')))) { throw new AttachmentFailure('unsupported'); }
    counts[kind]++; total += ref.byteLength;
    if (ref.byteLength > (kind === 'video' ? 8 : 4) * 1024 * 1024) { throw new AttachmentFailure('backpressure'); }
  }
  if (counts.image > 5 || counts.file > 5 || counts.video > 1 || total > 8 * 1024 * 1024) { throw new AttachmentFailure('backpressure'); }
}
export async function prepareAttachments(input: Input, options: { trustedBinding: string; sessionRef: string; port: AttachmentPort | undefined; signal: AbortSignal; timeoutMs: number; requirePath?: boolean }): Promise<PreparedAttachment[]> {
  const { trustedBinding, sessionRef, port, signal, timeoutMs, requirePath = false } = options;
  const deadline = Date.now() + timeoutMs;
  const prepared: PreparedAttachment[] = [];
  for (const reference of input.attachments ?? []) {
    signal.throwIfAborted();
    if (Date.now() >= deadline) { throw new AttachmentFailure('dependency-unavailable'); }
    const request = Object.freeze({ trustedBinding, sessionRef, inputId: input.inputId, operationRef: input.operationRef, fingerprint: inputFingerprint(input), reference });
    let result;
    try { result = await bounded(Promise.resolve().then(() => port!.resolve(request, signal)), Math.max(1, deadline - Date.now())); }
    catch { throw new AttachmentFailure('dependency-unavailable'); }
    signal.throwIfAborted();
    if (!result) { throw new AttachmentFailure('dependency-unavailable'); }
    if (!sameBinding(result.binding, request) || !(result.bytes instanceof Uint8Array) || result.bytes.byteLength !== reference.byteLength) { throw new AttachmentFailure('invalid-config'); }
    const bytes = Uint8Array.from(result.bytes);
    if (bytes.byteLength !== reference.byteLength || createHash('sha256').update(bytes).digest('hex') !== reference.digest ||
      (requirePath && (typeof result.nativePath !== 'string' || !result.nativePath.startsWith('/') || result.nativePath.includes('\0')))) { throw new AttachmentFailure('invalid-config'); }
    prepared.push({ reference, bytes, ...(result.nativePath !== undefined ? { nativePath: result.nativePath } : {}) });
  }
  return prepared;
}
export function assertSerializedAttachments(parts: unknown): void {
  if (Buffer.byteLength(JSON.stringify(parts)) > 7_500_000) { throw new AttachmentFailure('backpressure'); }
}
