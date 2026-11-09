import { isCanonicalOpenCodeV2LoopbackEndpoint } from './v2-loopback-endpoint.ts'
import { safeV2SessionID } from './v2-native-identifiers.ts'
import { record } from './v2-projection-helpers.ts'
import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
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
/**
 * Validate the private native workspace with the engine's actual path flavor.
 * Lexical validation alone is never process custody or a realpath attestation.
 */
export function isCanonicalV2DriverDirectory(
  directory: unknown,
  flavor: 'win32' | 'posix' = process.platform === 'win32' ? 'win32' : 'posix'
): boolean {
  if (typeof directory !== 'string' || directory.length === 0 ||
    directory.length > 8192 || directory.includes('\0')) return false;
  if (flavor === 'win32') {
    const root = win32.parse(directory).root;
    return /^[A-Za-z]:\\/.test(directory) && win32.isAbsolute(directory) &&
      win32.normalize(directory) === directory && directory.length > root.length &&
      directory.slice(root.length).split('\\').every(segment =>
        segment.length > 0 && !/[ .]$/.test(segment) &&
        !/[<>:"|?*\x00-\x1f]/.test(segment) &&
        !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(segment));
  }
  return posix.isAbsolute(directory) && !directory.endsWith('/') &&
    posix.normalize(directory) === directory && directory !== '/';
}

export function snapshotDriverConfig(config: OpenCodeV2DriverConfig, request: OpenConfig): OpenCodeV2DriverConfig {
  // Capture untrusted Host getters once. Validating a live object and then
  // spreading it later could swap the session, endpoint or SDK pin after checks.
  const fields = { ...config }
  if (record(fields) === null || record(fields.binding) === null || record(fields.limits) === null) {
    throw new Error('opencode.driver.invalid-config')
  }
  const captured = { ...fields, binding: { ...fields.binding }, limits: { ...fields.limits } }
  // RegExp.exec coerces a one-element JSON array to a string: type-check the
  // captured values, never read the original Host object again.
  if (captured.configRevision !== request.configRevision || !captured.trustedBinding?.trim() || !captured.accountBinding?.trim()
    || !safeV2SessionID(captured.nativeSessionId)
    || !isCanonicalV2DriverDirectory(captured.directory)
    || !isCanonicalOpenCodeV2LoopbackEndpoint(captured.endpoint)
    || !['2.0.0', '2.0.21'].includes(captured.version)
    || typeof captured.readPassword !== 'function' || typeof captured.probe !== 'function' || typeof captured.confirmStopped !== 'function'
    || ['queuedInputs', 'inputBytes', 'outputBytes', 'outputEvents', 'pendingInteractions', 'timeoutMs'].some(key => { const value = captured.limits[key as keyof Limits]; return !Number.isSafeInteger(value) || value <= 0 })
    || !['tenantId', 'projectId', 'sessionId', 'generation'].every(key => captured.binding[key as keyof typeof captured.binding] === request[key as keyof typeof captured.binding]))
    {throw new Error('opencode.driver.invalid-config')}
  return captured
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
