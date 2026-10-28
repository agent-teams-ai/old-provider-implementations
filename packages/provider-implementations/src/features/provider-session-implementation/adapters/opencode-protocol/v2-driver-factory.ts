import type { DriverFactory, OpenConfig } from '@agent-teams/provider-session-contracts'
import { checkDriverCheckpoint, snapshotDriverConfig } from './v2-driver-config.ts'
import type { OpenCodeV2DriverConfig } from './v2-driver-config.ts'
import { createV2DriverSession } from './v2-driver-session.ts'

export type OpenCodeV2DriverHost = {
  resolveConfiguration: (request: OpenConfig) => Promise<OpenCodeV2DriverConfig | undefined>
  readCheckpoint: (reference: string, request: OpenConfig) => Promise<unknown>
  /** Qualified subset of this implementation's finite capabilities for the exact Host. */
  capabilities: readonly string[]
}
const supported = new Set(['text', 'tools', 'permission', 'interrupt', 'checkpoint'])

/** Existing Host-selected session only. Runtime owns materialization and durable recovery. */
export function createOpenCodeV2DriverFactory(host: OpenCodeV2DriverHost): DriverFactory {
  const capabilities = Object.freeze([...host.capabilities])
  if (capabilities.some(value => typeof value !== 'string' || !supported.has(value))
    || new Set(capabilities).size !== capabilities.length) {throw new Error('opencode.driver.unsupported')}
  return {
    async open(request: OpenConfig) {
      const selected = Object.freeze({ ...request, requiredCapabilities: Object.freeze([...request.requiredCapabilities]) })
      if (selected.requiredCapabilities.some(value => !capabilities.includes(value))) {throw new Error('opencode.driver.unsupported')}
      let config: OpenCodeV2DriverConfig
      try {
        const resolved = await host.resolveConfiguration(selected)
        if (!resolved) {throw new Error('missing')}
        config = snapshotDriverConfig(resolved, selected)
      } catch { throw new Error('opencode.driver.invalid-config') }
      if (selected.checkpointRef !== undefined) {
        let checkpoint: unknown
        try { checkpoint = await host.readCheckpoint(selected.checkpointRef, selected) }
        catch { throw new Error('opencode.driver.checkpoint-missing') }
        if (checkpoint === undefined) {throw new Error('opencode.driver.checkpoint-missing')}
        if (!checkDriverCheckpoint(checkpoint, config)) {throw new Error('opencode.driver.checkpoint-incompatible')}
      }
      const driver = createV2DriverSession(config)
      const ready = await driver.checkReadiness()
      if (!ready.ok) { await driver.close(); throw new Error('opencode.driver.' + ready.code) }
      return { driver, capabilities }
    },
  }
}
