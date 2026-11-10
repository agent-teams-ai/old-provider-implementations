import type { OpenCodeV2DriverConfig } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-driver-config.ts'
import type { driverPeer } from './v2-driver-peer.ts'

export function nativeConfig(host: Awaited<ReturnType<typeof driverPeer>>): OpenCodeV2DriverConfig {
  return { endpoint: host.endpoint, directory: host.directory, nativeSessionId: host.sessionId,
    version: '2.0.21', readPassword: () => 'TEST-private', trustedBinding: 'TEST-host', accountBinding: 'TEST-account',
    binding: { tenantId: 'TEST-tenant', projectId: 'TEST-project', sessionId: 'TEST-runtime-session', generation: 1 }, configRevision: 'TEST-r1',
    limits: { queuedInputs: 2, inputBytes: 4096, outputBytes: 100_000, outputEvents: 100, pendingInteractions: 2, timeoutMs: 2000 },
    probe: async () => true, confirmStopped: async () => true }
}
