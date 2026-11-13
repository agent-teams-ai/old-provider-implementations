import { boundV2Request } from './v2-bounded-await.ts'
import { isCanonicalV2DriverDirectory } from './v2-driver-config.ts'
import { executionAssert, ExecutionTransportFailure } from './v2-failures.ts'
import { checkOpenCodeReadJson, MAX_V2_CHUNKS } from './v2-json-budget.ts'
import { isCanonicalOpenCodeV2LoopbackEndpoint } from './v2-loopback-endpoint.ts'
import { nativeV2ByteView } from './v2-native-byte-view.ts'
import { createV2RequestAdmission } from './v2-request-admission.ts'
import type { OpenCodeV2TransportConfig } from './v2-execution-transport.ts'

export type OpenCodeV2CredentialClientConfig = Omit<OpenCodeV2TransportConfig, 'nativeSessionId' | 'version'> & {
  version: '2.1.4'
  /** Host-selected native integration, independent of any conversation/session. */
  integrationId: string
}

export function nativeIntegrationId(value: unknown): asserts value is string {
  executionAssert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value),
    'invalid_native_integration')
}

/** Private finite credential wire. Never exported as a raw session capability. */
export function createV2CredentialWire(supplied: OpenCodeV2CredentialClientConfig) {
  const config = { ...supplied }, abort = new AbortController(), pending = new Set<Promise<unknown>>()
  let closed = false, cleanupUnknown = false
  executionAssert(config.version === '2.1.4', 'unqualified_version')
  executionAssert(isCanonicalOpenCodeV2LoopbackEndpoint(config.endpoint) &&
    isCanonicalV2DriverDirectory(config.directory), 'authority_mismatch')
  nativeIntegrationId(config.integrationId)
  executionAssert(config.beforeRequest === undefined || typeof config.beforeRequest === 'function', 'invalid_admission')
  const check = () => executionAssert(!closed && !cleanupUnknown && Number.isFinite(config.deadline) &&
    Date.now() < config.deadline && config.signal?.aborted !== true, 'authority_or_deadline')
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work); void work.finally(() => pending.delete(work)).catch(() => {}); return work
  }
  const request = async (operation: 'read' | 'connect' | 'rollback', value?: string): Promise<unknown> => {
    check()
    const controller = new AbortController()
    const signal = AbortSignal.any([abort.signal, controller.signal, ...(config.signal ? [config.signal] : [])])
    const remaining = () => Math.min(30_000, config.deadline - Date.now())
    const timer = setTimeout(() => controller.abort(), Math.max(0, remaining()))
    let invoked = false, response: Response | undefined, metadataValidated = false
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const admission = createV2RequestAdmission(config.beforeRequest, signal, config.deadline, track)
    try {
      let path = `/api/integration/${encodeURIComponent(config.integrationId)}`
      if (operation === 'connect') {
        executionAssert(typeof value === 'string' && value.trim().length > 0 &&
          Buffer.byteLength(value) <= 64 * 1024 && !/[\x00-\x1f\x7f]/.test(value), 'invalid_native_key')
        path += '/connect/key'
      }
      if (operation === 'rollback') {
        executionAssert(typeof value === 'string' && /^cred_[A-Za-z0-9]{1,250}$/.test(value), 'invalid_native_credential')
        path = `/api/credential/${value}`
      } else path += '?' + new URLSearchParams({ 'location[directory]': config.directory })
      await admission.acquire()
      check(); signal.throwIfAborted()
      const password = config.readPassword()
      executionAssert(typeof password === 'string' && password.length > 0 &&
        Buffer.byteLength(password) <= 64 * 1024 && !/[\x00-\x1f\x7f]/.test(password), 'credential_unavailable')
      check(); signal.throwIfAborted()
      const headers = new Headers({ authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64'),
        connection: 'close' })
      if (operation === 'connect') headers.set('content-type', 'application/json')
      const native = new Request(config.endpoint + path, {
        method: operation === 'read' ? 'GET' : operation === 'connect' ? 'POST' : 'DELETE',
        headers, credentials: 'omit', redirect: 'error', signal,
        ...(operation === 'connect' ? { body: JSON.stringify({ key: value }) } : {}),
      })
      invoked = true
      const receivedResponse = await boundV2Request(track((config.fetchImpl ?? fetch)(native, {
        headers, signal, credentials: 'omit', redirect: 'error',
      }).then(async received => {
        if (signal.aborted) { await received.body?.cancel(); throw new Error('deadline') }
        return received
      })), remaining(), signal)
      response = receivedResponse
      executionAssert(!receivedResponse.redirected && (!receivedResponse.url || receivedResponse.url === native.url), 'authority_mismatch')
      metadataValidated = true
      const body = receivedResponse.body
      if (body !== null) {
        try {
          const acquired = body.getReader()
          if (!acquired || typeof acquired.read !== 'function' || typeof acquired.cancel !== 'function' ||
            typeof acquired.releaseLock !== 'function') throw new Error('unowned reader')
          reader = acquired
        } catch { cleanupUnknown = true; throw new ExecutionTransportFailure('cleanup_unknown', 'unknown') }
      }
      let bytes = 0
      const chunks: Uint8Array[] = []
      if (reader) for (;;) {
        const part = await boundV2Request(track(reader.read()), remaining(), signal)
        check(); signal.throwIfAborted()
        if (part.done) break
        const chunk = nativeV2ByteView(part.value)
        executionAssert(chunk !== null, 'invalid_response')
        bytes += chunk.byteLength
        executionAssert(bytes <= 8 * 1024 * 1024 && chunks.length < MAX_V2_CHUNKS, 'body_limit')
        chunks.push(Buffer.from(chunk))
      }
      reader?.releaseLock(); reader = undefined
      check(); signal.throwIfAborted()
      const content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      if (operation !== 'read') {
        executionAssert(receivedResponse.status === 204 && content === '', 'native_credential_mutation_unknown')
        return undefined
      }
      executionAssert(receivedResponse.status === 200 &&
        receivedResponse.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json', 'invalid_native_integration')
      checkOpenCodeReadJson(content)
      return JSON.parse(content) as unknown
    } catch (error) {
      controller.abort()
      if (reader || response && !metadataValidated) {
        try {
          const work = reader ? reader.cancel() : response!.body?.cancel()
          if (work) await boundV2Request(track(work), 1000)
          reader?.releaseLock(); reader = undefined
        } catch { cleanupUnknown = true }
      }
      // Native error bodies and key-bearing network diagnostics never escape.
      throw new ExecutionTransportFailure(cleanupUnknown ? 'cleanup_unknown' :
        error instanceof ExecutionTransportFailure ? error.code : 'native_credential_request_failed',
      invoked || cleanupUnknown ? 'unknown' : 'not_submitted')
    } finally {
      clearTimeout(timer)
      try { admission.close() }
      catch { cleanupUnknown = true; throw new ExecutionTransportFailure('cleanup_unknown', 'unknown') }
    }
  }
  return {
    request: (operation: 'read' | 'connect' | 'rollback', value?: string) => track(request(operation, value)),
    async dispose() {
      closed = true; abort.abort()
      try { await boundV2Request(Promise.allSettled([...pending]), 2000) }
      catch { cleanupUnknown = true }
      executionAssert(!cleanupUnknown && pending.size === 0, 'cleanup_unknown')
    },
  }
}
