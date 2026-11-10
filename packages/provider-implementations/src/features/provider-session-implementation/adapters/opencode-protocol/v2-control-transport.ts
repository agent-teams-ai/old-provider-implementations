import { boundV2Request } from './v2-bounded-await.ts'
import { ExecutionTransportFailure, executionAssert, unsubmitted } from './v2-failures.ts'
import { checkOpenCodeReadJson } from './v2-json-budget.ts'
import { record } from './v2-projection-helpers.ts'
import type { OpenCodeV2TransportConfig } from './v2-execution-transport.ts'

export type OpenCodeV2SessionControlConfig = OpenCodeV2TransportConfig & { nativeSessionId: string }

type ControlRoutes = { listInstructions: boolean; putInstruction: boolean; interrupt: boolean; cancelInbox: boolean; permissions: boolean; reply: boolean }
function allowedControlMethod(method: string, routes: ControlRoutes): boolean {
  switch (method) {
    case 'GET': return routes.listInstructions || routes.permissions
    case 'PUT': return routes.putInstruction
    case 'POST': return routes.interrupt || routes.reply
    case 'DELETE': return routes.cancelInbox
    default: return false
  }
}
function controlRoutes(native: Request, config: OpenCodeV2SessionControlConfig): ControlRoutes {
  const url = new URL(native.url), session = `/api/session/${config.nativeSessionId}`
  const entries = config.version === '2.0.0' ? session + '/instructions/entries' : `/api/experimental/session/${config.nativeSessionId}/instructions/entries`
  const routes = { listInstructions: url.pathname === entries,
    putInstruction: new RegExp('^' + entries + '/[a-z0-9][a-z0-9._-]{0,255}$').test(url.pathname),
    interrupt: url.pathname === session + '/interrupt',
    cancelInbox: new RegExp('^' + session + '/inbox/[A-Za-z0-9_-]{1,256}$').test(url.pathname),
    permissions: new RegExp('^' + session + '/permission(?:/[A-Za-z0-9_-]{1,256})?$').test(url.pathname),
    reply: new RegExp('^' + session + '/permission/[A-Za-z0-9_-]{1,256}/reply$').test(url.pathname) }
  executionAssert(url.origin === config.endpoint && url.username.length === 0 && url.password.length === 0 && url.hash.length === 0, 'authority_mismatch')
  executionAssert(allowedControlMethod(native.method, routes), 'unsupported_input')
  const resume = config.version === '2.0.0' ? 'continue' : 'resume'
  executionAssert([...url.searchParams.keys()].every(key => routes.interrupt && key === resume && url.searchParams.getAll(key).length === 1)
    && (!routes.interrupt || url.searchParams.get(resume) === 'false'), 'unsupported_input')
  return routes
}
function validateControlBody(body: string, routes: ControlRoutes, version: string): void {
  checkOpenCodeReadJson(body)
  const fields = record(JSON.parse(body) as unknown)
  const key = routes.putInstruction ? 'value' : version === '2.0.0' ? 'reply' : 'decision'
  executionAssert(fields !== null && Object.keys(fields).length === 1 && Object.hasOwn(fields, key), 'unsupported_input')
  if (routes.reply) { executionAssert(typeof fields[key] === 'string' && ['once', 'always', 'reject'].includes(fields[key]), 'invalid_input') }
}
function controlResponse(response: Response, body: string, routes: ControlRoutes): Response {
  if (routes.putInstruction || routes.cancelInbox || routes.reply) {
    executionAssert(response.status === 204 && body === '', 'invalid_response')
    return new Response(null, { status: 204 })
  }
  executionAssert(response.ok && response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json', 'invalid_response')
  checkOpenCodeReadJson(body); JSON.parse(body)
  return new Response(body, { status: response.status, headers: response.headers })
}
/** Exact session-bound control wire. It cannot configure or stop a shared host. */
export function createV2ControlWire(supplied: OpenCodeV2SessionControlConfig) {
  const config = { ...supplied }, controllers = new Set<AbortController>(), pending = new Set<Promise<unknown>>()
  let closed = false
  executionAssert(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(config.endpoint)
    && /^ses_[a-zA-Z0-9]+$/.test(config.nativeSessionId), 'authority_mismatch')
  executionAssert(['2.0.0', '2.0.21'].includes(config.version), 'unqualified_version')
  const check = () =>{  executionAssert(!closed && Number.isFinite(config.deadline)
    && Date.now() < config.deadline && config.signal?.aborted !== true, 'authority_or_deadline'); }
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work); void work.finally(() => pending.delete(work)).catch(() => {}); return work
  }
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    let invoked = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const controller = new AbortController(); controllers.add(controller)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      check()
      let native = new Request(config.endpoint + path, init)
      const routes = controlRoutes(native, config)
      const { putInstruction, reply } = routes
      const signal = AbortSignal.any([controller.signal, native.signal, ...(config.signal ? [config.signal] : [])])
      const remaining = () => Math.min(30_000, config.deadline - Date.now())
      timer = setTimeout(() =>{  controller.abort(); }, Math.max(0, remaining()))
      const consume = async (body: ReadableStream<Uint8Array> | null, maximum: number) => {
        if (!body) {return ''}
        reader = body.getReader(); let bytes = 0; const parts: Uint8Array[] = []
        for (;;) {
          const part = await boundV2Request(track(reader.read()), remaining(), signal)
          if (part.done) {break}
          bytes += part.value.byteLength; executionAssert(bytes <= maximum, 'body_limit'); parts.push(part.value)
        }
        reader.releaseLock(); reader = undefined
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))
      }
      if (putInstruction || reply) {
        const body = await consume(native.body, 1024 * 1024)
        validateControlBody(body, routes, config.version)
        native = new Request(native.url, { method: native.method, headers: native.headers, body, signal: native.signal })
      } else {executionAssert(!native.body, 'unsupported_input')}
      const password = config.readPassword()
      executionAssert(typeof password === 'string' && password.length > 0 && Buffer.byteLength(password) <= 64 * 1024, 'credential_unavailable')
      check(); signal.throwIfAborted()
      const headers = new Headers(native.headers)
      if (putInstruction || reply) {headers.set('content-type', 'application/json')}
      headers.set('authorization', 'Basic ' + Buffer.from('opencode:' + password).toString('base64'))
      invoked = true
      const response = await boundV2Request(track((config.fetchImpl ?? fetch)(native,
        { headers, signal, redirect: 'error' }).then(async received => {
        if (signal.aborted) { await received.body?.cancel(); throw new Error('deadline') }; return received
      })), remaining(), signal)
      executionAssert(!response.redirected && (!response.url || new URL(response.url).origin === config.endpoint), 'authority_mismatch')
      const body = await consume(response.body, 8 * 1024 * 1024)
      check(); signal.throwIfAborted()
      return controlResponse(response, body, routes)
    } catch (error) {
      controller.abort()
      const failure = new ExecutionTransportFailure(error instanceof ExecutionTransportFailure ? error.code : 'transport_failure', invoked ? 'unknown' : 'not_submitted')
      if (!invoked) {unsubmitted.add(failure)}
      throw failure
    } finally {
      clearTimeout(timer); controllers.delete(controller)
      if (reader) { await boundV2Request(track(reader.cancel()), 1000).catch(() => {}); reader.releaseLock() }
    }
  }
  return {
    check,
    request: (path: string, init?: RequestInit) => track(request(path, init)),
    dispose: async () => {
      closed = true
      for (const controller of controllers) {controller.abort()}
      try { await boundV2Request(Promise.allSettled(pending), 2000) }
      catch { throw new ExecutionTransportFailure('cleanup_unknown', 'unknown') }
      if (pending.size !== 0) {throw new ExecutionTransportFailure('cleanup_unknown', 'unknown')}
    },
  }
}
