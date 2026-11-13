import type { DriverFactory, OpenConfig } from '@agent-teams/provider-session-contracts';
import { openClaudeHostSession } from './open-session.ts';
import type { ClaudeConfig, ClaudeSdkBoundary } from './open-session.ts';

/** Private runtime/Host projections. No credentials, native checkpoint bytes or SDK DTOs enter core. */
export type ClaudeDriverHost = {
  readonly resolveConfiguration: (request: OpenConfig) => Promise<ClaudeConfig | undefined>;
  readonly readCheckpoint: (reference: string, request: OpenConfig) => Promise<unknown>;
  /** Exact original launch/Runtime proof, supplied only by the captured Host composition. */
  readonly readCheckpointSource?: (reference: string, request: OpenConfig) => Readonly<{
    reference: string;
    request: OpenConfig;
    originalExecutable: Readonly<{ path: string; sha256: string }>;
    selectedExecutable: Readonly<{ path: string; sha256: string }>;
  }> | undefined;
  /** Capabilities of this exact Host binding, not a provider/deployment qualification claim. */
  readonly capabilities: readonly string[];
};

export function createClaudeDriverFactory(host: ClaudeDriverHost, sdk?: ClaudeSdkBoundary): DriverFactory {
  const capabilities = Object.freeze([...host.capabilities]);
  if (capabilities.some(value => typeof value !== 'string' || !value)) { throw new Error('claude.driver.invalid-capabilities'); }
  return {
    async open(request) {
      const selected = Object.freeze({ ...request, requiredCapabilities: Object.freeze([...request.requiredCapabilities]) });
      if (selected.requiredCapabilities.some(value => !capabilities.includes(value))) { throw new Error('claude.driver.unsupported'); }
      const configuration = await host.resolveConfiguration(selected);
      if (!configuration || configuration.configRevision !== selected.configRevision || configuration.sessionRef !== selected.sessionId) {
        throw new Error('claude.driver.invalid-config');
      }
      const selectedCapabilities = configuration.sessionPersistence === 'ephemeral'
        ? Object.freeze(capabilities.filter(value => value !== 'checkpoint')) : capabilities;
      if (selected.requiredCapabilities.some(value => !selectedCapabilities.includes(value))) { throw new Error('claude.driver.unsupported'); }
      if (configuration.sessionPersistence === 'ephemeral' && selected.checkpointRef !== undefined) { throw new Error('claude.driver.checkpoint-incompatible'); }
      const checkpoint = selected.checkpointRef === undefined ? undefined : await host.readCheckpoint(selected.checkpointRef, selected);
      if (selected.checkpointRef !== undefined && checkpoint === undefined) { throw new Error('claude.driver.checkpoint-missing'); }
      const reference = selected.checkpointRef, readSource = host.readCheckpointSource;
      const source = reference !== undefined && readSource
        ? Object.freeze({ reference, request: selected, read: () => readSource(reference, selected) }) : undefined;
      const opened = await openClaudeHostSession(configuration, checkpoint, source, sdk);
      if (!opened.ok) { throw new Error(`claude.driver.${opened.code}`); }
      return { driver: opened.value, capabilities: selectedCapabilities };
    },
  };
}
