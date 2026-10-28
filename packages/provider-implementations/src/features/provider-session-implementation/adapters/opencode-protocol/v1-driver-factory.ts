import type { DriverFactory, OpenConfig } from '@agent-teams/provider-session-contracts'
import { OpenCodeDriverSession } from './driver-session.ts'
import { createV1DriverBackend } from './v1-driver-backend.ts'
import { snapshotV1Config, v1Compatibility } from './v1-driver-config.ts'
import type { OpenCodeV1DriverConfig } from './v1-driver-config.ts'
export type OpenCodeV1DriverHost = {
  resolveConfiguration: (request: OpenConfig) => Promise<OpenCodeV1DriverConfig | undefined>
  readCheckpoint: (reference: string, request: OpenConfig) => Promise<unknown>
  capabilities: readonly string[]
}
const supported = new Set(['text', 'tools', 'permission', 'interrupt', 'checkpoint', 'attachments'])
/** Private native identity only. The factory still verifies full config compatibility before probe/effects. */
export function readOpenCodeV1CheckpointSessionId(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { throw new Error('opencode.v1.checkpoint-incompatible') }
  const cp = value as Record<string, unknown>
  if (cp.version !== 1 || cp.engine !== 'opencode-v1' || typeof cp.nativeSessionId !== 'string'
    || !/^ses_[A-Za-z0-9]{1,256}$/.test(cp.nativeSessionId) || typeof cp.compatibility !== 'string'
    || !/^[a-f0-9]{64}$/.test(cp.compatibility)
    || Object.keys(cp).toSorted().join(',') !== 'compatibility,engine,nativeSessionId,version') {
    throw new Error('opencode.v1.checkpoint-incompatible')
  }
  return cp.nativeSessionId
}

/** Existing explicitly selected V1 native session only; no Host/bootstrap/materialization. */
export function createOpenCodeV1DriverFactory(host: OpenCodeV1DriverHost): DriverFactory {
  const capabilities = Object.freeze([...host.capabilities])
  if (capabilities.some(value => !supported.has(value)) || new Set(capabilities).size !== capabilities.length) {throw new Error('opencode.v1.unsupported')}
  return { async open(request) {
    const selected = Object.freeze({ ...request, requiredCapabilities: Object.freeze([...request.requiredCapabilities]) })
    if (selected.requiredCapabilities.some(value => !capabilities.includes(value))) {throw new Error('opencode.v1.unsupported')}
    let config: OpenCodeV1DriverConfig
    try {
      const resolved = await host.resolveConfiguration(selected)
      if (!resolved) {throw new Error('missing')}
      config = snapshotV1Config(resolved, selected)
    } catch { throw new Error('opencode.v1.invalid-config') }
    const compatibility = v1Compatibility(config)
    if (selected.checkpointRef !== undefined) {
      let checkpoint: unknown
      try { checkpoint = await host.readCheckpoint(selected.checkpointRef, selected) }
      catch { throw new Error('opencode.v1.checkpoint-missing') }
      if (checkpoint === undefined) {throw new Error('opencode.v1.checkpoint-missing')}
      const cp = checkpoint as Record<string, unknown> | null
      if (!cp || cp.version !== 1 || cp.engine !== 'opencode-v1' || cp.nativeSessionId !== config.nativeSessionId || cp.compatibility !== compatibility) {throw new Error('opencode.v1.checkpoint-incompatible')}
    }
    const driver = new OpenCodeDriverSession({ ...config, attachmentModel: config.model.providerID + '/' + config.model.modelID, engine: 'opencode-v1', compatibility }, signal => createV1DriverBackend(config, signal))
    const ready = await driver.checkReadiness()
    if (!ready.ok) { await driver.close(); throw new Error('opencode.v1.' + ready.code) }
    return { driver, capabilities }
  } }
}
