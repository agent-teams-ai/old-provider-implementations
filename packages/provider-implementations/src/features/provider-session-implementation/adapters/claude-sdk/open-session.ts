import { query } from '@anthropic-ai/claude-agent-sdk';
import { isDeepStrictEqual } from 'node:util';
import type { OpenConfig, Reply, Session } from '@agent-teams/provider-session-contracts';
import { compatibility, freshNativeSession, readCheckpoint, SDK_REVISION, snapshotConfig, validConfig } from './config.ts';
import type { Checkpoint, ClaudeConfig } from './config.ts';
import type { ClaudeDriverHost } from './factory.ts';
import { bounded } from '../provider-session-io/io.ts';
import { fail } from './primitives.ts';
import { ClaudeSession } from './session.ts';
import type { QueryFactory } from './session.ts';
export type { ClaudeConfig } from './config.ts';
/** Controllable SDK seam is test-only. It preserves the real query options and iterable. */
export type ClaudeSdkBoundary = { query: QueryFactory; sessionExists: (session: string, config: ClaudeConfig) => Promise<boolean> };
const realBoundary: ClaudeSdkBoundary = {
  query,
  // Runtime must provide explicit session-store availability; never search ambient HOME.
  sessionExists: (session, config) => config.sessionExists(session),
};
type HostCheckpointSource = Readonly<{
  reference: string;
  request: OpenConfig;
  read: () => ReturnType<NonNullable<ClaudeDriverHost['readCheckpointSource']>>;
}>;
/** Public opening remains strict and has no Host compatibility argument. */
export function openClaudeSession(config: ClaudeConfig, checkpoint?: unknown, sdk: ClaudeSdkBoundary = realBoundary): Promise<Reply<Session>> {
  return open(config, checkpoint, sdk);
}
/** Internal factory entry only; deliberately absent from the public export barrels. */
export function openClaudeHostSession(config: ClaudeConfig, checkpoint: unknown, source: HostCheckpointSource | undefined, sdk: ClaudeSdkBoundary = realBoundary): Promise<Reply<Session>> {
  return open(config, checkpoint, sdk, source);
}
function originalExecutableCompatible(config: ClaudeConfig, cp: Checkpoint, source: HostCheckpointSource | undefined): boolean {
  if (!source || cp.engine !== '0.3.305' || config.executablePath === undefined) { return false; }
  // Only the hash projection omits the path. Native options keep the captured executable.
  const { executablePath, ...legacy } = config;
  if (cp.compatibility !== compatibility(legacy)) { return false; }
  try {
    const proof = source.read();
    if (!proof || proof.reference !== source.reference || source.request.checkpointRef !== source.reference ||
        !isDeepStrictEqual(proof.request, source.request)) { return false; }
    const original = proof.originalExecutable, selected = proof.selectedExecutable;
    return original?.path === executablePath && selected?.path === executablePath &&
      typeof original.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(original.sha256) &&
      selected.sha256 === original.sha256;
  } catch { return false; }
}
async function open(config: ClaudeConfig, checkpoint: unknown, sdk: ClaudeSdkBoundary, source?: HostCheckpointSource): Promise<Reply<Session>> {
  try { if (!validConfig(config)) { return fail('invalid-config'); } config = snapshotConfig(config); }
  catch { return fail('invalid-config'); }
  if (checkpoint !== undefined && config.sessionPersistence === 'ephemeral') { return fail('checkpoint-incompatible'); }
  const cp = checkpoint === undefined ? undefined : readCheckpoint(checkpoint);
  if (checkpoint !== undefined && (!cp || cp.engine !== SDK_REVISION ||
      (cp.compatibility !== compatibility(config) && !originalExecutableCompatible(config, cp, source)))) { return fail('checkpoint-incompatible'); }
  if (cp) {
    try { if (!await bounded(sdk.sessionExists(cp.nativeSession, config), config.limits.timeoutMs)) {return fail('checkpoint-missing');} }
    catch { return fail('checkpoint-missing'); }
  }
  let session: ClaudeSession;
  try { session = new ClaudeSession(config, cp?.nativeSession ?? freshNativeSession(), !!cp, sdk.query); }
  catch { return fail('provider-failure'); }
  const ready = await session.checkReadiness();
  if (!ready.ok) { await session.close(); return ready; }
  return { ok: true, value: session };
}
