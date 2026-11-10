import { validateExecutionBody, validateExecutionRoute } from './v2-input-validation.ts'
import { checkExecutionSse, checkOpenCodeReadJson } from './v2-json-budget.ts'
import { ExecutionTransportFailure, executionAssert, missingSessions, unsubmitted } from './v2-failures.ts'

type ExecutionFetchInput = RequestInfo | URL
type ExecutionFetchInit = RequestInit | undefined
export type OpenCodeV2TransportConfig = {
  endpoint: string
  version: '2.0.0' | '2.0.21'
  directory: string
  /** Private credential projection supplied by runtime custody; never emitted. */
  readPassword: () => string
  signal?: AbortSignal
  deadline: number
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

function executionResponseReader(response: Response) {
  return response.body?.getReader()
}

function missingSessionResponse(response: Response, request: Request, route: { session: boolean; url: URL }, chunks: Uint8Array[]): string | undefined {
  const media = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (request.method !== 'GET' || !route.session || response.status !== 404 || media !== 'application/json') { return undefined }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  checkOpenCodeReadJson(text)
  const error: unknown = JSON.parse(text), sessionID = decodeURIComponent(route.url.pathname.slice('/api/session/'.length))
  executionAssert(error !== null && typeof error === 'object' && !Array.isArray(error), 'invalid_response')
  const fields = error as Record<string, unknown>
  executionAssert(Object.keys(fields).toSorted().join(',') === '_tag,message,sessionID' && fields['_tag'] === 'SessionNotFoundError'
    && fields.sessionID === sessionID && typeof fields.message === 'string' && Buffer.byteLength(fields.message) <= 4096, 'invalid_response')
  return sessionID
}
function transportFailure(error: unknown, invoked: boolean): ExecutionTransportFailure {
  const code = error instanceof ExecutionTransportFailure ? error.code : 'transport_failure'
  const failure = new ExecutionTransportFailure(code, invoked ? 'unknown' : 'not_submitted')
  if (error !== null && typeof error === 'object') {
    const sessionID = missingSessions.get(error)
    if (sessionID !== undefined) { missingSessions.set(failure, sessionID) }
  }
  if (!invoked) { unsubmitted.add(failure) }
  return failure
}
/** Finite execution operations only. SSE is consumed within the same deadline,
 * then handed to the official decoder. This slice exposes no live subscription. */
class OpenCodeV2ExecutionFetch {
  private closed = false
  private readonly controllers = new Set<AbortController>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly io = new Set<Promise<unknown>>()
  private readonly endpoint: string
  private readonly pin: '2.0.0' | '2.0.21'
  private readonly directory: string
  private readonly readPassword: () => string
  private readonly context: { signal: AbortSignal | undefined; deadline: number }
  private readonly fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  constructor(config: OpenCodeV2TransportConfig) {
    this.endpoint = config.endpoint; this.pin = config.version; this.directory = config.directory
    this.readPassword = config.readPassword
    this.context = { signal: config.signal, deadline: config.deadline }
    this.fetchImpl = config.fetchImpl ?? fetch
    executionAssert(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(this.endpoint), 'authority_mismatch')
    executionAssert(['2.0.0', '2.0.21'].includes(this.pin), 'unqualified_version')
    executionAssert(Number.isFinite(this.context.deadline) && typeof this.directory === 'string' && this.directory.length > 0, 'deadline')
  }

  check(): void {
    executionAssert(!this.closed, 'disposed')
    executionAssert(this.context.signal?.aborted !== true && Date.now() < this.context.deadline, 'deadline')
  }
  private track<T>(work: Promise<T>, set = this.io): Promise<T> {
    set.add(work)
    void work.finally(() => set.delete(work)).catch(() => {})
    return work
  }
  private async bound<T>(work: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      executionAssert(!signal.aborted && ms > 0, 'deadline')
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        abort = () =>{  reject(new Error('deadline')); }
        signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(abort, ms)
      })])
    } finally { clearTimeout(timer); if (abort) {signal.removeEventListener('abort', abort)} }
  }
  fetch = Object.assign((input: ExecutionFetchInput, init?: ExecutionFetchInit) =>
    this.track(this.request(input, init), this.pending),
  { preconnect(): never { throw new ExecutionTransportFailure('capabilities_pending', 'not_submitted') } })

  private async validateRequest(input: ExecutionFetchInput, init: ExecutionFetchInit,
    controller: AbortController) {
    let reader
    try {
      let request = new Request(input, init)
      const { url, session, log, activation, create, prompt } = validateExecutionRoute(request, this.pin, this.directory, this.endpoint)
      if (create || prompt) {
        const validationSignal = AbortSignal.any([controller.signal, request.signal,
          ...(this.context.signal ? [this.context.signal] : [])])
        reader = request.body?.getReader()
        executionAssert(reader !== undefined, 'invalid_input')
        const pieces: Uint8Array[] = []; let bodyBytes = 0
        for (;;) {
          const part = await this.bound(this.track(reader.read()), validationSignal, this.context.deadline - Date.now())
          if (part.done) {break}
          const chunk: unknown = part.value
          executionAssert(chunk instanceof Uint8Array, 'invalid_input')
          bodyBytes += chunk.byteLength; executionAssert(bodyBytes <= 1024 * 1024, 'body_limit')
          pieces.push(chunk)
        }
        reader.releaseLock(); reader = undefined
        const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pieces))
        checkOpenCodeReadJson(body)
        const parsed: unknown = JSON.parse(body)
        validateExecutionBody(parsed, create, this.directory)
        request = new Request(request.url, { method: request.method, headers: request.headers, body, signal: request.signal })
      }
      if (activation) {executionAssert(!request.body, 'capabilities_pending')}
      return { request, url, session, log, activation }
    } finally {
      if (reader) {
        await this.bound(this.track(reader.cancel()), new AbortController().signal, 1000).catch(() => {})
        reader.releaseLock()
      }
    }
  }

  private async readResponse(reader: ReturnType<typeof executionResponseReader>, signal: AbortSignal): Promise<Uint8Array[]> {
    const chunks: Uint8Array[] = []
    let bytes = 0
    if (!reader) { return chunks }
    for (;;) {
      const part = await this.bound(this.track(reader.read()), signal, this.context.deadline - Date.now())
      this.check(); signal.throwIfAborted()
      if (part.done) { break }
      const chunk: unknown = part.value
      executionAssert(chunk instanceof Uint8Array, 'invalid_response')
      bytes += chunk.byteLength; executionAssert(bytes <= 8 * 1024 * 1024, 'body_limit'); chunks.push(chunk)
    }
    return chunks
  }
  private requestHeaders(request: Request, signal: AbortSignal): Headers {
    const headers = new Headers(request.headers), password = this.readPassword()
    executionAssert(typeof password === 'string' && password.length > 0 && Buffer.byteLength(password) <= 64 * 1024, 'credential_unavailable')
    headers.set('authorization', 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64'))
    // Credential projection may synchronously dispose/abort; no fetch can precede these rechecks.
    this.check(); signal.throwIfAborted()
    return headers
  }
  private async request(input: ExecutionFetchInput, init?: ExecutionFetchInit): Promise<Response> {
    let invoked = false
    let reader: ReturnType<typeof executionResponseReader> = undefined
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    this.controllers.add(controller)
    try {
      this.check()
      const { request, url, session, log, activation } = await this.validateRequest(input, init, controller)
      this.check(); request.signal.throwIfAborted()
      const signal = AbortSignal.any([controller.signal, request.signal, ...(this.context.signal ? [this.context.signal] : [])])
      timer = setTimeout(() =>{  controller.abort(); }, Math.min(30_000, this.context.deadline - Date.now()))
      const headers = this.requestHeaders(request, signal)
      invoked = true
      const responseWork = this.track(this.fetchImpl(request, { headers, signal, redirect: 'error' }).then(async response => {
        if (signal.aborted) { await response.body?.cancel(); throw new Error('deadline') }
        return response
      }))
      const response = await this.bound(responseWork, signal, this.context.deadline - Date.now())
      executionAssert(!response.redirected && (!response.url || new URL(response.url).origin === this.endpoint), 'authority_mismatch')
      reader = executionResponseReader(response)
      const chunks = await this.readResponse(reader, signal)
      const bytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      this.check(); signal.throwIfAborted()
      if (response.status === 204) {
        executionAssert(activation && bytes === 0, 'invalid_response')
        return new Response(null, { status: 204 })
      }
      const media = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      const sessionID = missingSessionResponse(response, request, { session, url }, chunks)
      if (sessionID !== undefined) {
        reader?.releaseLock(); reader = undefined
        this.check(); signal.throwIfAborted()
        // Both pinned public protocol errors declare this exact 404 shape.
        // Retain only the identity-bound absence fact, never the native message.
        const failure = new ExecutionTransportFailure('session_missing', 'unknown')
        missingSessions.set(failure, { sessionId: sessionID, endpoint: this.endpoint, directory: this.directory, version: this.pin })
        throw failure
      }
      // No response body/tag from an SDK error escapes this boundary.
      executionAssert(response.status >= 200 && response.status < 300, 'http_failure')
      executionAssert(media === (log ? 'text/event-stream' : 'application/json'), 'media_type')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      if (log) {checkExecutionSse(text)}
      else { checkOpenCodeReadJson(text); JSON.parse(text) }
      return new Response(text, { status: response.status, headers: response.headers })
    } catch (error) {
      controller.abort()
      if (reader) {await this.bound(this.track(reader.cancel()), new AbortController().signal, 1000).catch(() => {})}
      throw transportFailure(error, invoked)
    } finally {
      clearTimeout(timer); this.controllers.delete(controller)
      reader?.releaseLock()
    }
  }
  async dispose(): Promise<void> {
    this.closed = true
    for (const controller of this.controllers) {controller.abort()}
    const work = Promise.allSettled([...this.pending, ...this.io])
    try { await this.bound(work, new AbortController().signal, 2000) }
    catch { throw new ExecutionTransportFailure('cleanup_unknown', 'unknown') }
    if (this.pending.size !== 0 || this.io.size !== 0) {throw new ExecutionTransportFailure('cleanup_unknown', 'unknown')}
  }
}

export function createOpenCodeV2ExecutionTransport(config: OpenCodeV2TransportConfig) {
  return new OpenCodeV2ExecutionFetch(config)
}
