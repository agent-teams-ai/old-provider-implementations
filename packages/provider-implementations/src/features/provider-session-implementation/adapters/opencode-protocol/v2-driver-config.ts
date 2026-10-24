import { record } from './v2-projection-helpers.ts'
import { createHash } from 'node:crypto'
import type { Limits, OpenConfig } from '@agent-teams/provider-session-contracts'
import type { OpenCodeV2TransportConfig } from './v2-execution-transport.ts'

/** Private Host-selected existing session. Runtime owns creation, lease and current generation. */
export type OpenCodeV2DriverConfig = Omit<OpenCodeV2TransportConfig, 'deadline' | 'signal'> & {
  binding: Readonly<{ tenantId: string; projectId: string; sessionId: string; generation: number }>
  configRevision: string
  nativeSessionId: string
  trustedBinding: string
  accountBinding: string
  limits: Limits
  /** Read-only host/package/MCP/model/custody qualification for this exact binding. */
  probe: (signal: AbortSignal) => Promise<boolean>
  /** Confirms this owned execution stopped; never stops a shared host. */
  confirmStopped: () => Promise<boolean>
}
export function snapshotDriverConfig(config: OpenCodeV2DriverConfig, request: OpenConfig): OpenCodeV2DriverConfig {
  if (record(config) === null || config.configRevision !== request.configRevision || !config.trustedBinding || !config.accountBinding
    || !/^ses_[a-zA-Z0-9]+$/.test(config.nativeSessionId) || !config.directory.startsWith('/')
    || !/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(config.endpoint)
    || !['2.0.0', '2.0.21'].includes(config.version)
    || typeof config.readPassword !== 'function' || typeof config.probe !== 'function' || typeof config.confirmStopped !== 'function'
    || ['queuedInputs', 'inputBytes', 'outputBytes', 'outputEvents', 'pendingInteractions', 'timeoutMs'].some(key => { const value = config.limits[key as keyof Limits]; return !Number.isSafeInteger(value) || value <= 0 })
    || !['tenantId', 'projectId', 'sessionId', 'generation'].every(key => config.binding[key as keyof typeof config.binding] === request[key as keyof typeof config.binding]))
    {throw new Error('opencode.driver.invalid-config')}
  return { ...config, binding: { ...config.binding }, limits: { ...config.limits } }
}
export function driverCompatibility(config: OpenCodeV2DriverConfig): string {
  return createHash('sha256').update(JSON.stringify({ version: config.version, endpoint: config.endpoint,
    directory: config.directory, nativeSessionId: config.nativeSessionId, trustedBinding: config.trustedBinding,
    accountBinding: config.accountBinding, configRevision: config.configRevision,
    tenantId: config.binding.tenantId, projectId: config.binding.projectId, sessionId: config.binding.sessionId })).digest('hex')
}
export function checkDriverCheckpoint(value: unknown, config: OpenCodeV2DriverConfig): boolean {
  if (value === null || typeof value !== 'object') {return false}
  const checkpoint = value as Record<string, unknown>
  return checkpoint.version === 1 && checkpoint.engine === 'opencode-v2' && checkpoint.nativeSessionId === config.nativeSessionId
    && checkpoint.compatibility === driverCompatibility(config)
}
