import { isCanonicalOpenCodeV2LoopbackEndpoint } from './v2-loopback-endpoint.ts'
import { safeV2SessionID, safeV2MessageID, safeV2PermissionID } from './v2-native-identifiers.ts'
import { isCanonicalV2DriverDirectory } from './v2-driver-config.ts'
import { boundV2Request } from './v2-bounded-await.ts'
import { canonicalExecutionJSON } from './v2-canonical-json.ts'
import { ExecutionTransportFailure, executionAssert, unsubmitted } from './v2-failures.ts'
import { checkOpenCodeReadJson, MAX_V2_CHUNKS } from './v2-json-budget.ts'
import { record } from './v2-projection-helpers.ts'
import type { OpenCodeV2TransportConfig } from './v2-execution-transport.ts'

export type OpenCodeV2SessionControlConfig = OpenCodeV2TransportConfig & {
  nativeSessionId: string
  /** Private Driver mutation fence, checked after asynchronous request admission. */
  beforeMutation?: () => void
}

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
  const inboxPrefix = session + '/inbox/'
  const permissionPrefix = session + '/permission/'
  const inboxId = url.pathname.startsWith(inboxPrefix) ? url.pathname.slice(inboxPrefix.length) : null
  const permissionId = url.pathname.startsWith(permissionPrefix) ? url.pathname.slice(permissionPrefix.length) : null
  const replyId = permissionId?.endsWith('/reply') ? permissionId.slice(0, -'/reply'.length) : null
  const routes = { listInstructions: url.pathname === entries,
    putInstruction: new RegExp('^' + entries + '/[a-z0-9][a-z0-9._-]{0,255}$').test(url.pathname),
    interrupt: url.pathname === session + '/interrupt',
    cancelInbox: safeV2MessageID(inboxId),
    permissions: url.pathname === session + '/permission' || safeV2PermissionID(permissionId),
    reply: safeV2PermissionID(replyId) }
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
  if (routes.putInstruction) {
    // The raw control wire is not allowed to bypass the typed instruction API's
    // bounded durable-value policy before credentials or native side effects.
    executionAssert(Buffer.byteLength(canonicalExecutionJSON(fields[key])) <= 256 * 1024, 'body_limit')
  }
  if (routes.reply) {
    // V2 "always" persists a project-scoped allow pattern. This raw transport
    // must not provide a bypass around the Host's not-yet-qualified policy gate.
    executionAssert(fields[key] === 'once' || fields[key] === 'reject', 'invalid_input')
  }
}
function controlResponse(response: Response, body: string, routes: ControlRoutes): Response {
  if (routes.putInstruction || routes.cancelInbox || routes.reply) {
    executionAssert(response.status === 204 && body === '', 'invalid_response')
    return new Response(null, { status: 204 })
  }
  // Session-bound native readbacks and the interrupt receipt require a
  // complete HTTP 200; partial/async 2xx is not a confirmed control result.
  executionAssert(response.status === 200 && response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json', 'invalid_response')
  checkOpenCodeReadJson(body); JSON.parse(body)
  // Project only the documented JSON media type. Native/server-injected headers
  // are not a trusted public output channel for private paths or credentials.
  return new Response(body, { status: response.status, headers: { 'content-type': 'application/json' } })
}
/** Exact session-bound control wire. It cannot configure or stop a shared host. */
export function createV2ControlWire(supplied: OpenCodeV2SessionControlConfig) {
  const config = { ...supplied }, controllers = new Set<AbortController>(), pending = new Set<Promise<unknown>>()
  let closed = false
  // Raw control-wire callers bypass the DriverConfig snapshot. Never let
  // RegExp.exec coerce an untyped JSON array into a trusted loopback endpoint.

  executionAssert(isCanonicalOpenCodeV2LoopbackEndpoint(config.endpoint)
    && isCanonicalV2DriverDirectory(config.directory)
    && safeV2SessionID(config.nativeSessionId), 'authority_mismatch')
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
      let native = new Request(config.endpoint + path, { ...init, credentials: 'omit', redirect: 'error' })
      const routes = controlRoutes(native, config)
      const { putInstruction, reply } = routes
      const signal = AbortSignal.any([controller.signal, native.signal, ...(config.signal ? [config.signal] : [])])
      const remaining = () => Math.min(30_000, config.deadline - Date.now())
      timer = setTimeout(() =>{  controller.abort(); }, Math.max(0, remaining()))
      const consume = async (body: ReadableStream<Uint8Array> | null, maximum: number) => {
        if (body === null) {return ''}
        // A locked real native response throws on acquisition. An injected
        // response can also return no usable reader without throwing. Neither
        // establishes owned stream cleanup, even for a read-only permission GET.
        try {
          if (!body || typeof body.getReader !== 'function') throw new Error('unowned reader')
          const acquired = body.getReader()
          if (!acquired || typeof acquired.read !== 'function' || typeof acquired.cancel !== 'function'
            || typeof acquired.releaseLock !== 'function') throw new Error('unowned reader')
          reader = acquired
        } catch { throw new ExecutionTransportFailure('cleanup_unknown', 'unknown') }
        let bytes = 0; const parts: Uint8Array[] = []
        for (;;) {
          const part = await boundV2Request(track(reader.read()), remaining(), signal)
          if (part.done) {break}
          // Injected native response streams are untyped at runtime. Reject
          // non-byte chunks before arithmetic or Buffer.concat budget accounting.
          const chunk: unknown = part.value
          executionAssert(chunk instanceof Uint8Array, 'invalid_response')
          bytes += chunk.byteLength
          executionAssert(bytes <= maximum && parts.length < MAX_V2_CHUNKS, 'body_limit')
          parts.push(chunk)
        }
        reader.releaseLock(); reader = undefined
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))
      }
      if (putInstruction || reply) {
        const body = await consume(native.body, 1024 * 1024)
        validateControlBody(body, routes, config.version)
        native = new Request(native.url, { method: native.method, headers: native.headers, body,
          signal: native.signal, credentials: 'omit', redirect: 'error' })
      } else {executionAssert(!native.body, 'unsupported_input')}
      // Stream admission may outlive the original deadline or revoke the Host lease.
      // Revalidate before projecting credentials, not only before native fetch.
      check(); signal.throwIfAborted()
      if (native.method !== 'GET') config.beforeMutation?.()
      // The Host owner may synchronously revoke its lease inside the callback.
      // Recheck before revealing a credential to the callback's next step.
      check(); signal.throwIfAborted()
      const password = config.readPassword()
      executionAssert(typeof password === 'string' && password.length > 0 && Buffer.byteLength(password) <= 64 * 1024, 'credential_unavailable')
      check(); signal.throwIfAborted()
      if (native.method !== 'GET') config.beforeMutation?.()
      // An owner callback may revoke this lease before native dispatch.
      check(); signal.throwIfAborted()
      // The caller may supply arbitrary headers to this raw control wire;
      // never forward them with the Host-owned Basic credential.
      const headers = new Headers()
      if (putInstruction || reply) {headers.set('content-type', 'application/json')}
      headers.set('authorization', 'Basic ' + Buffer.from('opencode:' + password).toString('base64'))
      // Keep injected fetches from observing the caller's original headers or
      // ambient credential/redirect settings through their Request parameter.
      for (const key of [...native.headers.keys()]) native.headers.delete(key)
      for (const [key, value] of headers) native.headers.set(key, value)
      invoked = true
      const response = await boundV2Request(track((config.fetchImpl ?? fetch)(native,
        { headers, signal, redirect: 'error', credentials: 'omit' }).then(async received => {
        if (signal.aborted) { await received.body?.cancel(); throw new Error('deadline') }; return received
      })), remaining(), signal)
      executionAssert(!response.redirected && (!response.url || new URL(response.url).origin === config.endpoint), 'authority_mismatch')
      const body = await consume(response.body, 8 * 1024 * 1024)
      check(); signal.throwIfAborted()
      return controlResponse(response, body, routes)
    } catch (error) {
      controller.abort()
      // An admission fence may reject before this request invokes fetch while
      // the *prior prompt* already has UNKNOWN custody. Preserve that trusted
      // uncertainty: "not submitted" would permit an unsafe retry.
      const uncertain = error instanceof ExecutionTransportFailure && error.disposition === 'unknown'
      const failure = new ExecutionTransportFailure(error instanceof ExecutionTransportFailure ? error.code : 'transport_failure',
        invoked || uncertain ? 'unknown' : 'not_submitted')
      if (!invoked && !uncertain) {unsubmitted.add(failure)}
      throw failure
    } finally {
      clearTimeout(timer); controllers.delete(controller)
      if (reader) {
        // A failed or timed-out reader cancellation is NOT verified cleanup.
        // Do not let the preceding body error be mistaken for a clean refusal.
        let cleanupConfirmed = false
        try {
          await boundV2Request(track(reader.cancel()), 1000)
          reader.releaseLock()
          cleanupConfirmed = true
        } catch {
          // Injected native readers can reject, hang or throw on release.
        }
        if (!cleanupConfirmed) {throw new ExecutionTransportFailure('cleanup_unknown', 'unknown')}
      }
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
