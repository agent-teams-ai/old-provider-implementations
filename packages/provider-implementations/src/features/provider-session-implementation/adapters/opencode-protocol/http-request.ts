import { readOpenCodeBoundedHttpResponse } from './OpenCodeBoundedHttpResponse.ts'
import type { OpenCodeClientRequestContext } from './OpenCodeClientRequestContext.ts'
import { DEFAULT_REQUEST_TIMEOUT_MS } from './request-limits.ts'

export type OpenCodeRequest = <T>(path: string, init?: RequestInit, timeoutMs?: number,
  maxItems?: number, responseKind?: 'metadata' | 'transcript') => Promise<T>

export function isOpenCodeConnectionReset(error: unknown): boolean {
  const cause = error instanceof TypeError ? error.cause : undefined
  return cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ECONNRESET'
}

function resolveRequestTimeoutMs(
  endpointTimeoutMs: number,
  context: OpenCodeClientRequestContext,
): number {
  const remainingMs = context.remainingMs?.()
  if (remainingMs === undefined || remainingMs === Number.POSITIVE_INFINITY) {
    return endpointTimeoutMs
  }
  if (!Number.isFinite(remainingMs)) {
    return 0
  }
  return Math.max(0, Math.min(endpointTimeoutMs, Math.floor(remainingMs)))
}

function resolveAbortReason(signal: AbortSignal, fallback: Error): unknown {
  return signal.reason === undefined ? fallback : signal.reason
}

export function createOpenCodeRequest(baseUrl: string, context: OpenCodeClientRequestContext,
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): OpenCodeRequest {
  return async <T>(
      path: string,
      init?: RequestInit,
      endpointTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
      maxItems?: number,
      responseKind: 'metadata' | 'transcript' = 'metadata',
    ): Promise<T> => {
      const contextAborted = () => context.signal?.aborted === true
      const timeoutMs = resolveRequestTimeoutMs(endpointTimeoutMs, context)
      const deadline = Date.now() + timeoutMs
      const timeoutError = new Error(
        `OpenCode request timed out after ${timeoutMs}ms for ${path}`,
      )
      if (timeoutMs <= 0) {throw timeoutError}
      if (contextAborted()) {
        throw resolveAbortReason(context.signal!, timeoutError)
      }

      const controller = new AbortController()
      const abortFromContext = () => {
        if (!controller.signal.aborted && context.signal) {
          controller.abort(resolveAbortReason(context.signal, timeoutError))
        }
      }
      context.signal?.addEventListener('abort', abortFromContext, { once: true })
      const timeout = setTimeout(() => {
        controller.abort(timeoutError)
      }, timeoutMs)

      try {
        const requestInit: RequestInit = {
          ...init,
          redirect: 'error',
          signal: controller.signal,
          headers: (() => { const headers = new Headers(init?.headers); if (!headers.has('content-type')) { headers.set('content-type', 'application/json') }; return headers })(),
        }
        const attempt = () => fetchImpl(baseUrl + path, requestInit)
        let response: Response
        try { response = await attempt() }
        catch (error) {
          // Only a rejected pre-response GET is repeatable; keep the original timer and controller.
          if ((init?.method ?? 'GET') !== 'GET' || !isOpenCodeConnectionReset(error)
            || controller.signal.aborted || contextAborted() || Date.now() >= deadline
            || context.remainingMs && !(context.remainingMs() > 0)) { throw error }
          response = await attempt()
        }
        // Keep the timer and caller abort listener until the body is consumed.
        try {
          controller.signal.throwIfAborted()
          if (context.remainingMs && context.remainingMs() <= 0) {throw timeoutError}
        } catch (error) { void response.body?.cancel().catch(() => {}); throw error }
        const result = await readOpenCodeBoundedHttpResponse(response, controller.signal, maxItems ?? 256, context.remainingMs, responseKind) as T
        controller.signal.throwIfAborted()
        return result
      } catch (error) {
        if (contextAborted()) {
          throw resolveAbortReason(context.signal!, timeoutError)
        }
        if (controller.signal.aborted) {
          throw resolveAbortReason(controller.signal, timeoutError)
        }
        throw error
      } finally {
        clearTimeout(timeout)
        context.signal?.removeEventListener('abort', abortFromContext)
      }
    }

}
