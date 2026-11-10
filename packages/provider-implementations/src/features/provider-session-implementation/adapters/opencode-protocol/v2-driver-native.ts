import { createOpenCodeV2ExecutionTransport } from './v2-execution-transport.ts'
import { createOpenCodeV2SessionControl } from './v2-session-control.ts'
import { decodeV2DataEnvelope, decodeV2Log, decodeV2Session } from './v2-cut-codecs.ts'
import { readOpenCodeV2NativeCut } from './v2-native-cut.ts'
import { record } from './v2-projection-helpers.ts'
import { ExecutionTransportFailure, unsubmitted } from './v2-failures.ts'
import { safeV2MessageID } from './v2-native-identifiers.ts'
import type { OpenCodeV2DriverConfig } from './v2-driver-config.ts'

export type NativeDriverInput = { nativeInputID: string; text: string; beforeCursor: number | null }
/** Each operation has a fresh finite deadline. No mutable transport lasts across turns. */
export function createDriverNative(config: OpenCodeV2DriverConfig, signal: AbortSignal) {
  let cleanupUnknown = false
  let promptUnknown = false
  // One native prompt admission at a time. A concurrent second queue can
  // otherwise reach POST before the first lost ACK latches promptUnknown.
  let queueActive = false
  let closed = false
  let activeOperations = 0
  const shutdown = new AbortController()
  const nativeSignal = AbortSignal.any([signal, shutdown.signal])
  const assertUsable = (mutating = false): void => {
    if (cleanupUnknown) throw new ExecutionTransportFailure('cleanup_unknown', 'unknown')
    if (closed) {
      const failure = new ExecutionTransportFailure('native_driver_closed', 'not_submitted')
      unsubmitted.add(failure)
      throw failure
    }
    // After an unconfirmed prompt POST, only read-only reconciliation is safe.
    if (mutating && promptUnknown) throw new ExecutionTransportFailure('native_prompt_unknown', 'unknown')
  }
  // UNKNOWN native I/O custody remains UNKNOWN across driver close, even when
  // the finite wire has no outstanding tracked promise by the time it disposes.
  const rememberUncertainCleanup = (error: unknown): void => {
    if ((error instanceof ExecutionTransportFailure && error.code === 'cleanup_unknown') ||
      (error instanceof Error && error.message === 'native_read_cleanup_unknown')) cleanupUnknown = true
  }
  const dispose = async (wire: { dispose: () => Promise<void> }) => {
    try { await wire.dispose() } catch (error) { cleanupUnknown = true; throw error }
  }
  const wireConfig = () => ({ ...config, signal: nativeSignal, deadline: Date.now() + config.limits.timeoutMs })
  const path = `/api/session/${config.nativeSessionId}`
  const read = async (original: NativeDriverInput) => {
    assertUsable()
    activeOperations++
    try {
      const wire = createOpenCodeV2ExecutionTransport(wireConfig())
      try {
        const result = await readOpenCodeV2NativeCut(wire, { endpoint: config.endpoint, directory: config.directory,
          sessionID: config.nativeSessionId, pin: config.version }, original)
        // A concurrent close may revoke physical custody after readback succeeds.
        assertUsable()
        return result
      }
      catch (error) {
        rememberUncertainCleanup(error)
        if (cleanupUnknown) throw new ExecutionTransportFailure('cleanup_unknown', 'unknown')
        throw error
      } finally { await dispose(wire) }
    } finally {
      activeOperations--
      // A close can race the awaited wire.dispose() AFTER the operation returned.
      // Never certify success when the physical close latched UNKNOWN custody.
      if (cleanupUnknown) throw new ExecutionTransportFailure('cleanup_unknown', 'unknown')
    }
  }
  const queue = async (nativeInputID: string, text: string): Promise<NativeDriverInput> => {
    assertUsable(true)
    // Reject malformed input before even the native session/log preflight GET:
    // these reads carry Host Basic credentials and cannot validate a bad queue.
    // The wire also checks the eventual POST, but that is too late for preflight.
    if (!safeV2MessageID(nativeInputID) || typeof text !== 'string'
      || text.trim().length === 0 || Buffer.byteLength(text) > 256 * 1024) {
      const failure = new ExecutionTransportFailure('invalid_input', 'not_submitted')
      unsubmitted.add(failure)
      throw failure
    }
    if (queueActive) {
      const failure = new ExecutionTransportFailure('native_prompt_in_flight', 'not_submitted')
      unsubmitted.add(failure)
      throw failure
    }
    queueActive = true
    activeOperations++
    try {
      const wire = createOpenCodeV2ExecutionTransport(wireConfig())
      let mutation = false
      try {
      decodeV2Session(await (await wire.fetch(config.endpoint + path)).json() as unknown, config.nativeSessionId, config.directory)
      const log = decodeV2Log(await (await wire.fetch(config.endpoint + `/api/experimental/session/${config.nativeSessionId}/log?follow=false`)).text(),
        config.nativeSessionId, config.directory)
      // The stock V2 CLI can acknowledge a prompt while exposing only log.synced
      // (event retention disabled). Without the original durable session prefix,
      // no future model turn has a verifiable ownership/terminal lineage.
      if (log.events.length === 0) throw new Error('native_durable_log_unqualified')
      // Close can race a preflight GET; never admit a POST after shutdown.
      assertUsable(true)
      mutation = true
      const receipt = record(decodeV2DataEnvelope(await (await wire.fetch(config.endpoint + path + '/prompt', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: nativeInputID, text, resume: true, delivery: 'queue' }) })).json() as unknown))
      if (!receipt || receipt.id !== nativeInputID || receipt.sessionID !== config.nativeSessionId
        || receipt.type !== 'user' || receipt.delivery !== 'queue' || record(receipt.payload)?.text !== text) {throw new Error('native_handoff_identity_mismatch')}
      // A close that raced the acknowledged POST cannot be reported as clean.
      assertUsable(true)
      return { nativeInputID, text, beforeCursor: log.watermark }
      } catch (error) {
      rememberUncertainCleanup(error)
      if (mutation) promptUnknown = true
      if (cleanupUnknown) throw new ExecutionTransportFailure('cleanup_unknown', 'unknown')
      if (!mutation) {
        // A read-only preflight cannot have submitted the prompt, but failed
        // native stream cleanup is still UNKNOWN custody, not a clean refusal.
        if (error instanceof ExecutionTransportFailure && error.code === 'cleanup_unknown') {throw error}
        const failure = new ExecutionTransportFailure('preflight_failed', 'not_submitted'); unsubmitted.add(failure); throw failure
      }
      throw error
      } finally { await dispose(wire) }
    } finally {
      queueActive = false
      activeOperations--
      if (cleanupUnknown) throw new ExecutionTransportFailure('cleanup_unknown', 'unknown')
    }
  }
  const control = async <T>(run: (wire: ReturnType<typeof createOpenCodeV2SessionControl>) => Promise<T>, scopedSignal?: AbortSignal) => {
    assertUsable()
    activeOperations++
    try {
    const wire = createOpenCodeV2SessionControl({ ...wireConfig(), nativeSessionId: config.nativeSessionId, signal: scopedSignal ? AbortSignal.any([nativeSignal, scopedSignal]) : nativeSignal,
      beforeMutation: () => assertUsable(true) })
    // A control callback may await before choosing its actual operation. Fence
    // every session-scoped mutation at invocation, not merely at control entry.
    const guarded: typeof wire = {
      ...wire,
      interrupt: () => { assertUsable(true); return wire.interrupt() },
      cancelInbox: id => { assertUsable(true); return wire.cancelInbox(id) },
      replyPermission: (id, decision) => { assertUsable(true); return wire.replyPermission(id, decision) },
      putInstruction: (key, value) => { assertUsable(true); return wire.putInstruction(key, value) },
    }
    try {
      const result = await run(guarded)
      // The callback can be suspended without having started a wire request.
      // A concurrent close must still invalidate a late "success" return.
      assertUsable()
      return result
    }
    catch (error) {
      rememberUncertainCleanup(error)
      if (cleanupUnknown) throw new ExecutionTransportFailure('cleanup_unknown', 'unknown')
      throw error
    } finally { await dispose(wire) }
    } finally {
      activeOperations--
      // A close can race the awaited wire.dispose() AFTER the operation returned.
      // Never certify success when the physical close latched UNKNOWN custody.
      if (cleanupUnknown) throw new ExecutionTransportFailure('cleanup_unknown', 'unknown')
    }
  }
  return { read, queue, control, async dispose() {
    closed = true
    shutdown.abort()
    // A live operation may still own HTTP/stream custody. Never report a
    // successful Session SPI close or allow a delayed prompt after that close.
    if (activeOperations > 0) cleanupUnknown = true
    if (cleanupUnknown) throw new ExecutionTransportFailure('cleanup_unknown', 'unknown')
  } }
}
