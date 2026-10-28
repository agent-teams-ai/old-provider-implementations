import { canonicalExecutionJSON } from './v2-canonical-json.ts'
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
        responseBytes += part.value.byteLength; budget.bytes += part.value.byteLength
        if (responseBytes > 8 * 1024 * 1024 || budget.bytes > 32 * 1024 * 1024) { throw new Error('native_cut_byte_budget') }
        chunks.push(part.value)
      }
    }
  } finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() } }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}
function validateReadBinding(binding: OpenCodeV2ReadBinding, input: Readonly<{ nativeInputID: string; beforeCursor: number | null; text: string }>): void {
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(binding.endpoint) || binding.directory.length === 0
    || !/^ses_[a-zA-Z0-9]+$/.test(binding.sessionID) || !/^msg_[a-zA-Z0-9]+$/.test(input.nativeInputID)
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
    transport.check()
    const response = await transport.fetch(binding.endpoint + path, { method: 'GET', redirect: 'error' })
    const media = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (!response.ok || response.redirected || response.url && new URL(response.url).origin !== binding.endpoint
      || media !== (path.includes('/log?') ? 'text/event-stream' : 'application/json')) {throw new Error('invalid_native_read_response')}
    const text = await nativeResponseBody(response, transport, budget)
    transport.check()
    return text
  }
  const sessionPath = `/api/session/${encodeURIComponent(binding.sessionID)}`
  const session = () => read(sessionPath).then(text => decodeV2Session(JSON.parse(text) as unknown, binding.sessionID, binding.directory))
  const log = () => read(`/api/experimental/session/${encodeURIComponent(binding.sessionID)}/log?follow=false`)
    .then(text => decodeV2Log(text, binding.sessionID, binding.directory))
  const beforeSession = await session(), beforeLog = await log()
  const messages: OpenCodeV2NativeMessage[] = [], cursors = new Set<string>()
  let cursor: string | undefined, complete = false
  for (let page = 0; page < 8; page++) {
    const query = new URLSearchParams({ limit: '200', ...(cursor === undefined ? {} : { cursor }) })
    const result = decodeV2MessagePage(JSON.parse(await read(`${sessionPath}/message?${query}`)) as unknown, binding.sessionID)
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
