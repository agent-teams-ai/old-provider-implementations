import { createOpenCodeV2ExecutionTransport } from './v2-execution-transport.ts'
import { createOpenCodeV2SessionControl } from './v2-session-control.ts'
import { decodeV2Log, decodeV2Session } from './v2-cut-codecs.ts'
import { readOpenCodeV2NativeCut } from './v2-native-cut.ts'
import { record } from './v2-projection-helpers.ts'
import { ExecutionTransportFailure, unsubmitted } from './v2-failures.ts'
import type { OpenCodeV2DriverConfig } from './v2-driver-config.ts'

export type NativeDriverInput = { nativeInputID: string; text: string; beforeCursor: number | null }
/** Each operation has a fresh finite deadline. No mutable transport lasts across turns. */
export function createDriverNative(config: OpenCodeV2DriverConfig, signal: AbortSignal) {
  let cleanupUnknown = false
  const dispose = async (wire: { dispose: () => Promise<void> }) => {
    try { await wire.dispose() } catch (error) { cleanupUnknown = true; throw error }
  }
  const wireConfig = () => ({ ...config, signal, deadline: Date.now() + config.limits.timeoutMs })
  const path = `/api/session/${config.nativeSessionId}`
  const read = async (original: NativeDriverInput) => {
    const wire = createOpenCodeV2ExecutionTransport(wireConfig())
    try { return await readOpenCodeV2NativeCut(wire, { endpoint: config.endpoint, directory: config.directory,
      sessionID: config.nativeSessionId, pin: config.version }, original) }
    finally { await dispose(wire) }
  }
  const queue = async (nativeInputID: string, text: string): Promise<NativeDriverInput> => {
    const wire = createOpenCodeV2ExecutionTransport(wireConfig())
    let mutation = false
    try {
      decodeV2Session(await (await wire.fetch(config.endpoint + path)).json() as unknown, config.nativeSessionId, config.directory)
      const log = decodeV2Log(await (await wire.fetch(config.endpoint + `/api/experimental/session/${config.nativeSessionId}/log?follow=false`)).text(),
        config.nativeSessionId, config.directory)
      mutation = true
      const receipt = record(await (await wire.fetch(config.endpoint + path + '/prompt', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: nativeInputID, text, resume: true, delivery: 'queue' }) })).json() as unknown)
      if (!receipt || receipt.id !== nativeInputID || receipt.sessionID !== config.nativeSessionId
        || receipt.type !== 'user' || receipt.delivery !== 'queue' || record(receipt.payload)?.text !== text) {throw new Error('native_handoff_identity_mismatch')}
      return { nativeInputID, text, beforeCursor: log.watermark }
    } catch (error) {
      if (!mutation) {
        const failure = new ExecutionTransportFailure('preflight_failed', 'not_submitted'); unsubmitted.add(failure); throw failure
      }
      throw error
    } finally { await dispose(wire) }
  }
  const control = async <T>(run: (wire: ReturnType<typeof createOpenCodeV2SessionControl>) => Promise<T>, scopedSignal?: AbortSignal) => {
    const wire = createOpenCodeV2SessionControl({ ...wireConfig(), nativeSessionId: config.nativeSessionId, signal: scopedSignal ? AbortSignal.any([signal, scopedSignal]) : signal })
    try { return await run(wire) } finally { await dispose(wire) }
  }
  return { read, queue, control, async dispose() { if (cleanupUnknown) {throw new Error('cleanup_unknown')} } }
}
