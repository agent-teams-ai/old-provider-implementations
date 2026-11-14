import { channel } from 'node:diagnostics_channel'
import { nativeV2ByteView } from './v2-native-byte-view.ts'
import { isCanonicalOpenCodeV2LoopbackEndpoint } from './v2-loopback-endpoint.ts'
import { isCanonicalV2DriverDirectory } from './v2-driver-config.ts'
import { safeV2MessageID, safeV2SessionID } from './v2-native-identifiers.ts'
import { canonicalExecutionJSON } from './v2-canonical-json.ts'
import { checkOpenCodeReadJson, MAX_V2_CHUNKS } from './v2-json-budget.ts'
import { boundV2Request } from './v2-bounded-await.ts'
import { ExecutionTransportFailure } from './v2-failures.ts'
import { decodeV2Log, decodeV2MessagePage, decodeV2Session } from './v2-cut-codecs.ts'
import { isV2ExecutionVersion } from './v2-protocol-version.ts'
import type { V2ExecutionVersion } from './v2-protocol-version.ts'
import type { OpenCodeV2NativeMessage, OpenCodeV2NativeTurnCut } from './v2-projection-types.ts'

export type OpenCodeV2ReadBinding = Readonly<{
  endpoint: string; directory: string; sessionID: string; pin: V2ExecutionVersion
}>
export type OpenCodeV2ReadTransport = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  check: () => void
  signal?: AbortSignal
}

// One shared deadline for the entire readback, including paginated GETs and
// injected body streams. A byte/chunk cap alone does not bound idle IO.
const MAX_V2_NATIVE_CUT_READ_MS = 30_000
const failureChannel = channel('agent-teams:opencode-v2:read-cut-failed')
type CutStage = 'before-session' | 'before-log' | 'messages' | 'after-log' | 'after-session' | 'comparison'
const failureReasons = ['deadline', 'cleanup_unknown', 'native_read_cleanup_unknown', 'invalid_native_read_response',
  'invalid_native_read_json', 'native_session_binding_mismatch', 'invalid_native_envelope', 'invalid_native_page',
  'invalid_native_model', 'invalid_native_position', 'invalid_native_identity', 'incomplete_native_log',
  'incomplete_native_transcript', 'native_cut_byte_budget', 'frame_limit', 'body_limit', 'transport_failure',
  'authority_mismatch', 'disposed', 'media_type', 'http_failure', 'mutable_native_readback', 'unknown'] as const
type CutFailure = Readonly<{ stage: CutStage; reason: typeof failureReasons[number]; elapsedMs: number;
  deadlineExpired: boolean; aborted: boolean }>
function failureReason(error: unknown): CutFailure['reason'] {
  try {
    const key = error instanceof ExecutionTransportFailure ? 'code' : error instanceof Error ? 'message' : undefined
    const field = key && Object.getOwnPropertyDescriptor(error, key)
    const value: unknown = field && 'value' in field ? field.value : undefined
    return typeof value === 'string' && (failureReasons as readonly string[]).includes(value)
      ? value as CutFailure['reason'] : 'unknown'
  } catch { return 'unknown' }
}
function publishFailure(failure: CutFailure): void {
  if (failure.reason === 'mutable_native_readback') return
  try { if (failureChannel.hasSubscribers) failureChannel.publish(failure) }
  catch { /* Passive diagnostics cannot replace the original read failure. */ }
}
function unknownCleanup(error: unknown): boolean {
  const reason = failureReason(error)
  return reason === 'cleanup_unknown' || reason === 'native_read_cleanup_unknown'
}

async function nativeResponseBody(response: Response, transport: OpenCodeV2ReadTransport,
  budget: { bytes: number }, deadline: number, signal: AbortSignal, failed: (error: unknown) => void): Promise<string> {
  // A public injected Response can already have a locked body. If reader
  // ownership cannot be acquired, cancellation is not confirmed: never
  // describe an unobserved native stream as a clean invalid response.
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const body = response.body
    reader = body?.getReader()
    // An injected getReader() can return null/undefined without throwing.
    // A present body without an owned reader has no confirmed cleanup.
    if (body && !reader) throw new Error('native_read_cleanup_unknown')
  } catch { throw new Error('native_read_cleanup_unknown') }
  const chunks: Uint8Array[] = []
  let responseBytes = 0
  try {
    if (reader) {
      for (;;) {
        const part = await boundV2Request(reader.read(), deadline - Date.now(), signal); transport.check()
        if (part.done) { break }
        // Injected streams are not runtime-typed: non-byte chunks must never
        // bypass the finite byte budget or force unbounded additional reads.
        const chunk = nativeV2ByteView(part.value)
        if (chunk === null) throw new Error('invalid_native_read_response')
        responseBytes += chunk.byteLength; budget.bytes += chunk.byteLength
        if (responseBytes > 8 * 1024 * 1024 || budget.bytes > 32 * 1024 * 1024 || chunks.length >= MAX_V2_CHUNKS) {
          // A byte cap alone permits millions of tiny chunks and unbounded array overhead.
          throw new Error('native_cut_byte_budget')
        }
        chunks.push(Buffer.from(chunk))
      }
    }
  } catch (error) {
    failed(error); throw error
  } finally {
    if (reader) {
      // The public read cut accepts injected streams: cancellation can hang
      // indefinitely after a rejected body. Fail closed on uncertain cleanup.
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const cancelled = await Promise.race([
          reader.cancel().then(() => true, () => false),
          new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 1000) }),
        ])
        if (!cancelled) throw new Error('native_read_cleanup_unknown')
        reader.releaseLock()
      } catch {
        // Failed cancellation or lock release leaves reader custody unknown.
        throw new Error('native_read_cleanup_unknown')
      } finally {
        clearTimeout(timeout)
      }
    }
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}
// Public read-cut callers can inject a transport that bypasses the bounded
// execution wire. Never expose native JSON bytes through JSON.parse errors.
function parseNativeReadJSON(source: string): unknown {
  try {
    checkOpenCodeReadJson(source)
    return JSON.parse(source) as unknown
  } catch {
    throw new Error('invalid_native_read_json')
  }
}
function validateReadBinding(binding: OpenCodeV2ReadBinding, input: Readonly<{ nativeInputID: string; beforeCursor: number | null; text: string; nativeFilesDigest?: string }>): void {
  // Direct public read-cut callers can bypass the DriverConfig snapshot. A
  // one-element JSON array coerces to a matching string under RegExp.test;
  // reject that, overflow ports and malformed workspace values BEFORE fetch.

  if (!isCanonicalOpenCodeV2LoopbackEndpoint(binding.endpoint)
    || !isCanonicalV2DriverDirectory(binding.directory)
    || !safeV2SessionID(binding.sessionID) || !safeV2MessageID(input.nativeInputID)
    || !isV2ExecutionVersion(binding.pin)
    || !(input.beforeCursor === null || Number.isSafeInteger(input.beforeCursor) && input.beforeCursor >= 0)
    || typeof input.text !== 'string' || input.text.trim().length === 0 || Buffer.byteLength(input.text) > 256 * 1024 ||
    input.nativeFilesDigest !== undefined && (binding.pin !== '2.1.4' || typeof input.nativeFilesDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.nativeFilesDigest))) { throw new Error('invalid_native_read_binding') }
}
/** Finite read-only cut; runtime still owns endpoint/session custody and admission. */
export async function readOpenCodeV2NativeCut(transport: OpenCodeV2ReadTransport,
  supplied: OpenCodeV2ReadBinding,
  original: Readonly<{ nativeInputID: string; beforeCursor: number | null; text: string; nativeFilesDigest?: string }>): Promise<OpenCodeV2NativeTurnCut> {
  const binding = structuredClone(supplied), input = structuredClone(original)
  validateReadBinding(binding, input)
  const started = Date.now(), budget = { bytes: 0 }, deadline = started + MAX_V2_NATIVE_CUT_READ_MS
  const cutAbort = new AbortController()
  const cutSignal = transport.signal ? AbortSignal.any([cutAbort.signal, transport.signal]) : cutAbort.signal
  // Per-call evidence only. Capture before translation/self-abort; never expose the Error.
  const failures = new Map<unknown, CutFailure>()
  let originalFailure: CutFailure | undefined
  const remember = (stage: CutStage, error: unknown, signal = cutSignal, propagated = error) => {
    const now = Date.now()
    const fact = failures.get(error) ?? Object.freeze({ stage, reason: failureReason(error),
      elapsedMs: Math.max(0, Math.min(60_000, now - started)), deadlineExpired: now >= deadline,
      aborted: signal.aborted })
    failures.set(propagated, fact)
    originalFailure ??= fact
  }
  const observe = async <T>(stage: CutStage, work: () => Promise<T>): Promise<T> => {
    try { return await work() }
    catch (error) { if (!failures.has(error)) remember(stage, error); throw error }
  }
  const read = async (path: string, stage: CutStage) => {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, cutSignal])
    let fetchPending = false
    try {
      transport.check(); signal.throwIfAborted()
      fetchPending = true
      // If injected fetch ignores abort and resolves *after* our bounded wait,
      // reclaim its late response body best-effort. Custody was already UNKNOWN:
      // never turn this asynchronous cancellation into a clean read receipt.
      const pendingFetch = transport.fetch(binding.endpoint + path,
        { method: 'GET', redirect: 'error', signal })
      const response = await boundV2Request(pendingFetch.then(received => {
        if (signal.aborted) {
          try { void received.body?.cancel().catch(() => {}) } catch { /* unknown custody */ }
          throw new Error('native_read_cleanup_unknown')
        }
        return received
      }), deadline - Date.now(), signal)
      fetchPending = false
      // Injected metadata getters can throw before the native response stream
      // has a reader. Do not report a clean refusal while its body is unowned.
      const cancelUnclaimedBody = async () => {
        let body: ReadableStream<Uint8Array> | null
        try { body = response.body } catch { throw new Error('native_read_cleanup_unknown') }
        if (!body) return
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined
        let cancelled = false
        try {
          cancelled = await Promise.race([
            body.cancel().then(() => true, () => false),
            new Promise<boolean>(resolve => { cleanupTimer = setTimeout(() => resolve(false), 1000) }),
          ])
        } catch { /* Native body cancellation was not confirmed. */ }
        finally { clearTimeout(cleanupTimer) }
        if (!cancelled) throw new Error('native_read_cleanup_unknown')
      }
      let rejected: boolean
      try {
        const media = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
        const responseUrl = response.url
        let originMatches = !responseUrl
        if (responseUrl) {
          try { originMatches = new URL(responseUrl).origin === binding.endpoint }
          catch { originMatches = false }
        }
        // Complete session/log/message readbacks require exact HTTP 200.
        rejected = response.status !== 200 || response.redirected || !originMatches
          || media !== (path.includes('/log?') ? 'text/event-stream' : 'application/json')
      } catch {
        await cancelUnclaimedBody()
        throw new Error('invalid_native_read_response')
      }
      if (rejected) {
        await cancelUnclaimedBody()
        throw new Error('invalid_native_read_response')
      }
      const text = await nativeResponseBody(response, transport, budget, deadline, signal,
        error => remember(stage, error, signal))
      transport.check()
      return text
    } catch (error) {
      remember(stage, error, signal)
      const reject: (failure: Error) => never = (failure) => { remember(stage, error, signal, failure); throw failure }
      // A fetch which ignores abort/timeout has no confirmed response-body
      // custody. Do not misreport the unresolved operation as a clean refusal.
      if (fetchPending && (signal.aborted || Date.now() >= deadline)) {
        reject(new Error('native_read_cleanup_unknown'))
      }
      // An injected public read transport can reject with raw native payloads,
      // header values or OS diagnostics; only fixed read-budget codes escape.
      if (error instanceof ExecutionTransportFailure && error.code === 'cleanup_unknown') {
        reject(new Error('native_read_cleanup_unknown'))
      }
      if (error instanceof Error && ['invalid_native_read_response', 'native_cut_byte_budget',
        'native_read_cleanup_unknown', 'frame_limit', 'body_limit'].includes(error.message)) throw error
      reject(new Error('invalid_native_read_response'))
    } finally {
      controller.abort()
    }
  }
  const sessionPath = `/api/session/${encodeURIComponent(binding.sessionID)}`
  const session = (stage: CutStage) => observe(stage, async () =>
    decodeV2Session(parseNativeReadJSON(await read(sessionPath, stage)), binding.sessionID, binding.directory))
  const log = (stage: CutStage) => observe(stage, async () =>
    decodeV2Log(await read(`/api/experimental/session/${encodeURIComponent(binding.sessionID)}/log?follow=false`, stage),
      binding.sessionID, binding.directory))
  try {
    // The initial session binding must pass before any log or message access.
    const beforeSession = await session('before-session'), beforeLog = await log('before-log')
    const messages = await observe('messages', async () => {
      const values: OpenCodeV2NativeMessage[] = [], cursors = new Set<string>()
      let cursor: string | undefined, complete = false
      for (let page = 0; page < 8; page++) {
        const query = new URLSearchParams({ limit: '200', ...(cursor === undefined
          ? binding.pin === '2.1.4' ? { order: 'asc' } : {} : { cursor }) })
        const result = decodeV2MessagePage(parseNativeReadJSON(await read(`${sessionPath}/message?${query}`, 'messages')), binding.sessionID)
        values.push(...result.data)
        if (values.length > 1600 || new Set(values.map(row => row.id)).size !== values.length) {throw new Error('incomplete_native_transcript')}
        if (result.data.length === 0) {
          if (result.next !== null || result.previous !== null) {throw new Error('incomplete_native_transcript')}
          complete = true; break
        }
        if (result.next === null || result.previous === null || cursors.has(result.next)) {throw new Error('incomplete_native_transcript')}
        cursors.add(result.next); cursor = result.next
      }
      if (!complete) {throw new Error('incomplete_native_transcript')}
      return values
    })
    // Only the final independent observations overlap. A failed sibling cannot
    // leave another original reader detached or replace UNKNOWN cleanup.
    const firstFailure: unknown[] = []
    const join = async <T>(work: Promise<T>): Promise<T> => {
      try { return await work }
      catch (error) { if (!firstFailure.length) firstFailure.push(error); cutAbort.abort(); throw error }
    }
    const results = await Promise.allSettled([join(log('after-log')), join(session('after-session'))])
    const unresolved = results.find(result => result.status === 'rejected' && unknownCleanup(result.reason))
    if (unresolved?.status === 'rejected') throw unresolved.reason
    if (firstFailure.length) throw firstFailure[0]
    const [afterLog, afterSession] = results
    if (afterLog.status !== 'fulfilled' || afterSession.status !== 'fulfilled') throw new Error('native_read_cleanup_unknown')
    if (canonicalExecutionJSON(beforeLog) !== canonicalExecutionJSON(afterLog.value)
      || canonicalExecutionJSON(beforeSession) !== canonicalExecutionJSON(afterSession.value)) {throw new Error('mutable_native_readback')}
    return { pin: binding.pin, sessionID: binding.sessionID, nativeInputID: input.nativeInputID,
      beforeCursor: input.beforeCursor, originalText: input.text,
      ...(input.nativeFilesDigest ? { originalFilesDigest: input.nativeFilesDigest } : {}),
      messages: { data: messages, previous: null, next: null }, log: afterLog.value }
  } catch (error) {
    if (!failures.has(error)) remember('comparison', error)
    cutAbort.abort()
    publishFailure(originalFailure!)
    throw error
  }
}
