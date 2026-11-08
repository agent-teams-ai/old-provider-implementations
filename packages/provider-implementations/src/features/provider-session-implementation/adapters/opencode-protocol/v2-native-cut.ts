import { isCanonicalOpenCodeV2LoopbackEndpoint } from './v2-loopback-endpoint.ts'
import { isCanonicalV2DriverDirectory } from './v2-driver-config.ts'
import { safeV2MessageID, safeV2SessionID } from './v2-native-identifiers.ts'
import { canonicalExecutionJSON } from './v2-canonical-json.ts'
import { checkOpenCodeReadJson, MAX_V2_CHUNKS } from './v2-json-budget.ts'
import { decodeV2Log, decodeV2MessagePage, decodeV2Session } from './v2-cut-codecs.ts'
import type { OpenCodeV2NativeMessage, OpenCodeV2NativeTurnCut } from './v2-projection-types.ts'

export type OpenCodeV2ReadBinding = Readonly<{
  endpoint: string; directory: string; sessionID: string; pin: '2.0.0' | '2.0.21'
}>
export type OpenCodeV2ReadTransport = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  check: () => void
}

async function nativeResponseBody(response: Response, transport: OpenCodeV2ReadTransport, budget: { bytes: number }): Promise<string> {
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []
  let responseBytes = 0
  try {
    if (reader) {
      for (;;) {
        const part = await reader.read(); transport.check()
        if (part.done) { break }
        // Injected streams are not runtime-typed: non-byte chunks must never
        // bypass the finite byte budget or force unbounded additional reads.
        if (!(part.value instanceof Uint8Array)) throw new Error('invalid_native_read_response')
        responseBytes += part.value.byteLength; budget.bytes += part.value.byteLength
        if (responseBytes > 8 * 1024 * 1024 || budget.bytes > 32 * 1024 * 1024 || chunks.length >= MAX_V2_CHUNKS) {
          // A byte cap alone permits millions of tiny chunks and unbounded array overhead.
          throw new Error('native_cut_byte_budget')
        }
        chunks.push(part.value)
      }
    }
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
      } finally {
        clearTimeout(timeout)
        reader.releaseLock()
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
function validateReadBinding(binding: OpenCodeV2ReadBinding, input: Readonly<{ nativeInputID: string; beforeCursor: number | null; text: string }>): void {
  // Direct public read-cut callers can bypass the DriverConfig snapshot. A
  // one-element JSON array coerces to a matching string under RegExp.test;
  // reject that, overflow ports and malformed workspace values BEFORE fetch.

  if (!isCanonicalOpenCodeV2LoopbackEndpoint(binding.endpoint)
    || !isCanonicalV2DriverDirectory(binding.directory)
    || !safeV2SessionID(binding.sessionID) || !safeV2MessageID(input.nativeInputID)
    || !['2.0.0', '2.0.21'].includes(binding.pin)
    || !(input.beforeCursor === null || Number.isSafeInteger(input.beforeCursor) && input.beforeCursor >= 0)
    || typeof input.text !== 'string' || Buffer.byteLength(input.text) > 256 * 1024) { throw new Error('invalid_native_read_binding') }
}
/** Finite read-only cut; runtime still owns endpoint/session custody and admission. */
export async function readOpenCodeV2NativeCut(transport: OpenCodeV2ReadTransport,
  supplied: OpenCodeV2ReadBinding,
  original: Readonly<{ nativeInputID: string; beforeCursor: number | null; text: string }>): Promise<OpenCodeV2NativeTurnCut> {
  const binding = structuredClone(supplied), input = structuredClone(original)
  validateReadBinding(binding, input)
  const budget = { bytes: 0 }
  const read = async (path: string) => {
    try {
      transport.check()
      const response = await transport.fetch(binding.endpoint + path, { method: 'GET', redirect: 'error' })
      const media = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (!response.ok || response.redirected || response.url && new URL(response.url).origin !== binding.endpoint
        || media !== (path.includes('/log?') ? 'text/event-stream' : 'application/json')) {throw new Error('invalid_native_read_response')}
      const text = await nativeResponseBody(response, transport, budget)
      transport.check()
      return text
    } catch (error) {
      // An injected public read transport can reject with raw native payloads,
      // header values or OS diagnostics; only fixed read-budget codes escape.
      if (error instanceof Error && ['invalid_native_read_response', 'native_cut_byte_budget',
        'native_read_cleanup_unknown', 'frame_limit', 'body_limit'].includes(error.message)) throw error
      throw new Error('invalid_native_read_response')
    }
  }
  const sessionPath = `/api/session/${encodeURIComponent(binding.sessionID)}`
  const session = () => read(sessionPath).then(text => decodeV2Session(parseNativeReadJSON(text), binding.sessionID, binding.directory))
  const log = () => read(`/api/experimental/session/${encodeURIComponent(binding.sessionID)}/log?follow=false`)
    .then(text => decodeV2Log(text, binding.sessionID, binding.directory))
  const beforeSession = await session(), beforeLog = await log()
  const messages: OpenCodeV2NativeMessage[] = [], cursors = new Set<string>()
  let cursor: string | undefined, complete = false
  for (let page = 0; page < 8; page++) {
    const query = new URLSearchParams({ limit: '200', ...(cursor === undefined ? {} : { cursor }) })
    const result = decodeV2MessagePage(parseNativeReadJSON(await read(`${sessionPath}/message?${query}`)), binding.sessionID)
    messages.push(...result.data)
    if (messages.length > 1600 || new Set(messages.map(row => row.id)).size !== messages.length) {throw new Error('incomplete_native_transcript')}
    if (result.data.length === 0) {
      if (result.next !== null || result.previous !== null) {throw new Error('incomplete_native_transcript')}
      complete = true; break
    }
    if (result.next === null || result.previous === null || cursors.has(result.next)) {throw new Error('incomplete_native_transcript')}
    cursors.add(result.next); cursor = result.next
  }
  if (!complete) {throw new Error('incomplete_native_transcript')}
  const afterLog = await log(), afterSession = await session()
  if (canonicalExecutionJSON(beforeLog) !== canonicalExecutionJSON(afterLog)
    || canonicalExecutionJSON(beforeSession) !== canonicalExecutionJSON(afterSession)) {throw new Error('mutable_native_readback')}
  return { pin: binding.pin, sessionID: binding.sessionID, nativeInputID: input.nativeInputID,
    beforeCursor: input.beforeCursor, originalText: input.text,
    messages: { data: messages, previous: null, next: null }, log: afterLog }
}
