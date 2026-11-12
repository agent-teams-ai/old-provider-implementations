import { OpenCodeDriverSession } from './driver-session.ts'
import { createV2DriverBackend } from './v2-driver-backend.ts'
import { driverCompatibility } from './v2-driver-config.ts'
import type { OpenCodeV2DriverConfig } from './v2-driver-config.ts'

export function createV2DriverSession(config: OpenCodeV2DriverConfig) {
  // TypeScript's boolean contract does not constrain an injected Host callback
  // at runtime. A truthy object/number is neither a valid owner admission nor
  // physical process-stop attestation; do not let the shared Session SPI's
  // truthiness checks elevate those values to success.
  const qualified: OpenCodeV2DriverConfig = {
    ...config,
    probe: async signal => (await config.probe(signal)) === true,
    confirmStopped: async () => (await config.confirmStopped()) === true,
  }
  return new OpenCodeDriverSession({ ...qualified, ...(qualified.attachments ? { attachmentModel: qualified.attachments.model } : {}),
    engine: 'opencode-v2', compatibility: driverCompatibility(config) },
    signal => createV2DriverBackend(qualified, signal))
}
