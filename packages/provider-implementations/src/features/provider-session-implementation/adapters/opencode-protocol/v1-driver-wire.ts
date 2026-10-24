import { OpenCodeClientFactory } from './OpenCodeClientFactory.ts'
import type { OpenCodeClient } from './client-types.ts'
import { createOpenCodeRequest } from './http-request.ts'
import { boundV2Request } from './v2-bounded-await.ts'
import { ExecutionTransportFailure, unsubmitted } from './v2-failures.ts'
import type { OpenCodeV1DriverConfig } from './v1-driver-config.ts'

export function v1NotSubmitted(code: string): Error {
  const error = new ExecutionTransportFailure(code, 'not_submitted'); unsubmitted.add(error); return error
}
async function validateNativeRequest(request: Request, config: OpenCodeV1DriverConfig): Promise<void> {
  const url = new URL(request.url), session = '/session/' + config.nativeSessionId
  if (url.origin !== config.endpoint || url.username.length > 0 || url.password.length > 0 || url.hash.length > 0
    || !(request.method === 'GET' && [session, session + '/message', '/session/status', '/permission', '/question'].includes(url.pathname)
    || request.method === 'POST' && ([session + '/prompt_async', session + '/abort'].includes(url.pathname) || /^\/permission\/[A-Za-z0-9_-]{1,256}$/.test(url.pathname)))) { throw new Error('unsupported_native_route') }
  for (const key of url.searchParams.keys()) {
    if (url.pathname !== session + '/message' || !['limit', 'before'].includes(key) || url.searchParams.getAll(key).length !== 1) { throw new Error('unsupported_native_query') }
  }
  if (request.body && Buffer.byteLength(await request.clone().text()) > 1024 * 1024) { throw new Error('native_input_byte_budget') }
}
function verifyNativeResponse(response: Response, endpoint: string): void {
  if (response.redirected || response.url.length > 0 && new URL(response.url).origin !== endpoint) { throw new Error('foreign_native_response') }
  const media = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (response.status !== 204 && media !== 'application/json') { throw new Error('invalid_native_media') }
}
/** Owned finite IO around retained V1 HTTP operations; no Host or native process ownership. */
export function createV1DriverWire(config: OpenCodeV1DriverConfig, lifetime: AbortSignal) {
  const io = new Set<Promise<unknown>>()
  const track = <T>(work: Promise<T>) => { io.add(work); void work.finally(() => io.delete(work)).catch(() => {}); return work }
  const use = async <T>(run: (client: OpenCodeClient, questions: () => Promise<unknown>) => Promise<T>, scoped?: AbortSignal): Promise<T> => {
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, lifetime, ...(scoped ? [scoped] : [])])
    const deadline = Date.now() + config.limits.timeoutMs
    let bytes = 0
    const remaining = () => deadline - Date.now()
    const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      let invoked = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        signal.throwIfAborted()
        const request = new Request(input, init)
        await validateNativeRequest(request, config)
        signal.throwIfAborted()
        if (remaining() <= 0) {throw new Error('deadline')}
        invoked = true
        const response = await boundV2Request(track((config.fetchImpl ?? fetch)(request, { signal, redirect: 'error' }).then(async received => {
          if (signal.aborted) { await received.body?.cancel(); throw new Error('deadline') }; return received
        })), remaining(), signal)
        verifyNativeResponse(response, config.endpoint)
        reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let bodyBytes = 0
        if (reader) {for (;;) {
          const part = await boundV2Request(track(reader.read()), remaining(), signal)
          if (part.done) { break }
          bytes += part.value.byteLength; bodyBytes += part.value.byteLength
          if (bytes > 32 * 1024 * 1024 || bodyBytes > 8 * 1024 * 1024) { throw new Error('native_read_byte_budget') }
          chunks.push(part.value)
        }}
        signal.throwIfAborted()
        if (remaining() <= 0) {throw new Error('deadline')}
        return new Response(response.status === 204 ? null : Buffer.concat(chunks), { status: response.status, headers: response.headers })
      } catch {
        if (!invoked) {throw v1NotSubmitted('native_not_submitted')}
        throw new ExecutionTransportFailure('native_transport_failure', 'unknown')
      } finally { if (reader) { await boundV2Request(track(reader.cancel()), 1000).catch(() => {}); reader.releaseLock() } }
    }
    const context = { signal, remainingMs: remaining, boundedReconciliation: true }
    const client = new OpenCodeClientFactory({ fetchImpl: wrappedFetch }).create(config.endpoint, context)
    const request = createOpenCodeRequest(config.endpoint, context, wrappedFetch)
    try { return await boundV2Request(track(run(client, () => request('/question'))), remaining()) }
    finally { abort.abort() }
  }
  return { use, async dispose() {
    await boundV2Request(Promise.allSettled(io), 2000)
    if (io.size) {throw new Error('cleanup_unknown')}
  } }
}
