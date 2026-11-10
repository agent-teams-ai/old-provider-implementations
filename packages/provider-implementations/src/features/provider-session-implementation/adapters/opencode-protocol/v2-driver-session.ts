import { OpenCodeDriverSession } from './driver-session.ts'
import { createV2DriverBackend } from './v2-driver-backend.ts'
import { driverCompatibility } from './v2-driver-config.ts'
import type { OpenCodeV2DriverConfig } from './v2-driver-config.ts'

export function createV2DriverSession(config: OpenCodeV2DriverConfig) {
  return new OpenCodeDriverSession({ ...config, engine: 'opencode-v2', compatibility: driverCompatibility(config) },
    signal => createV2DriverBackend(config, signal))
}
