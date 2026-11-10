import type { DriverFactory, OpenConfig } from '@agent-teams/provider-session-contracts'
import { captureDriverConfig, selectedDriverCheckpoint } from './driver-config.ts'
import type { CodexDriverCheckpoint, CodexDriverConfig } from './driver-config.ts'
import { CodexDriverSession } from './driver-session.ts'

export type CodexDriverHost = {
  readonly resolveConfiguration: (request: OpenConfig) => Promise<CodexDriverConfig | undefined>
  readonly readCheckpoint: (reference: string, request: OpenConfig) => Promise<unknown>
  readonly capabilities: readonly string[]
}
const supported = new Set(['text', 'tools', 'usage', 'permission', 'interrupt', 'checkpoint', 'attachments'])

/** Native transport is caller-selected, exclusive to this binding and already under caller custody. */
export function createCodexDriverFactory(host: CodexDriverHost): DriverFactory {
  const capabilities = Object.freeze([...host.capabilities])
  if (capabilities.some(value => !supported.has(value)) || new Set(capabilities).size !== capabilities.length) {throw new Error('codex.driver.unsupported')}
  return { async open(request) {
    const selected = Object.freeze({ ...request, requiredCapabilities: Object.freeze([...request.requiredCapabilities]) })
    if (selected.requiredCapabilities.some(value => !capabilities.includes(value))) {throw new Error('codex.driver.unsupported')}
    let config: CodexDriverConfig
    try { const value = await host.resolveConfiguration(selected); if (!value) {throw new Error('missing');} config = captureDriverConfig(value, selected) }
    catch { throw new Error('codex.driver.invalid-config') }
    let restored: CodexDriverCheckpoint | undefined
    if (selected.checkpointRef !== undefined) {
      let checkpoint: unknown
      try { checkpoint = await host.readCheckpoint(selected.checkpointRef, selected) } catch { throw new Error('codex.driver.checkpoint-missing') }
      if (checkpoint === undefined) {throw new Error('codex.driver.checkpoint-missing')}
      restored = selectedDriverCheckpoint(checkpoint, config)
    }
    const driver = new CodexDriverSession(config, restored)
    const mandatoryNativeTools = Object.keys(config.requiredMcpTools ?? {}).length > 0 || config.mcpPolicy !== undefined
    try {
      if (!mandatoryNativeTools) {
        const ready = await driver.checkReadiness()
        if (!ready.ok) {throw new Error('codex.driver.' + ready.code)}
      }
      await driver.open(restored?.nativeThreadId)
    } catch { await driver.close(); throw new Error('codex.driver.open-failed') }
    // Thread-scoped discovery requires the owned native thread. No turn/work is
    // submitted until native mandatory tools and the Host probe both pass.
    if (mandatoryNativeTools) {
      const ready = await driver.checkReadiness()
      if (!ready.ok) { await driver.close(); throw new Error('codex.driver.' + ready.code) }
    }
    return { driver, capabilities }
  } }
}
