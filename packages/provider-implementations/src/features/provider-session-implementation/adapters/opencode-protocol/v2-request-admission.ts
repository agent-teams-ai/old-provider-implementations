import { boundV2Request } from './v2-bounded-await.ts'
import { ExecutionTransportFailure, executionAssert } from './v2-failures.ts'

/** Private Host admission for one finite native request, held through body cleanup. */
export type V2RequestAdmission = (signal: AbortSignal) => Promise<void | (() => void)>

export function createV2RequestAdmission(
  beforeRequest: V2RequestAdmission | undefined,
  signal: AbortSignal,
  deadline: number,
  track: <T>(work: Promise<T>) => Promise<T>,
  lifecycleSignal?: AbortSignal
) {
  let release: (() => void) | undefined, closed = false, pending = false, cleanupUnknown = false
  const close = (): void => {
    closed = true
    const owned = release
    release = undefined
    if (owned) {
      try { owned() } catch { cleanupUnknown = true }
    }
    if (cleanupUnknown) throw new ExecutionTransportFailure('cleanup_unknown', 'unknown')
  }
  return {
    async acquire(): Promise<void> {
      if (!beforeRequest) return
      signal.throwIfAborted()
      pending = true
      // Keep the original promise tracked after timeout. A late acquired lease
      // must be released, and transport disposal cannot certify it while pending.
      const work = track(Promise.resolve().then(() => {
        signal.throwIfAborted()
        return beforeRequest(signal)
      }).then(value => {
        pending = false
        executionAssert(value === undefined || typeof value === 'function', 'invalid_admission')
        release = typeof value === 'function' ? value : undefined
        if (closed) close()
      }, error => { pending = false; throw error }))
      try { await boundV2Request(work, deadline - Date.now(), signal) }
      catch (error) {
        // Abort can win before the original Host callback finishes releasing its
        // reservation. Join only that work within this request's original cutoff;
        // the original context shutdown must still interrupt the settlement.
        if (pending && signal.aborted && Date.now() < deadline) {
          try { await boundV2Request(work, deadline - Date.now(), lifecycleSignal) }
          catch (settlementError) {
            if (pending || Date.now() >= deadline) throw new ExecutionTransportFailure('cleanup_unknown', 'unknown')
            if (error instanceof ExecutionTransportFailure &&
                (error.disposition === 'unknown' || error.code === 'cleanup_unknown')) throw error
            throw settlementError
          }
          if (Date.now() >= deadline) throw new ExecutionTransportFailure('cleanup_unknown', 'unknown')
        }
        // Native bytes were not sent, but an unresolved Host acquisition may
        // already own a lease. Do not relabel unknown custody as safely retryable.
        if (pending) throw new ExecutionTransportFailure('cleanup_unknown', 'unknown')
        throw error
      }
    },
    close,
  }
}
