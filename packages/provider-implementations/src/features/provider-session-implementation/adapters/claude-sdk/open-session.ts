import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Reply, Session } from '@agent-teams/provider-session-contracts';
import { compatibility, freshNativeSession, readCheckpoint, SDK_REVISION, snapshotConfig, validConfig } from './config.ts';
import type { ClaudeConfig } from './config.ts';
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
export async function openClaudeSession(config: ClaudeConfig, checkpoint?: unknown, sdk: ClaudeSdkBoundary = realBoundary): Promise<Reply<Session>> {
  try { if (!validConfig(config)) { return fail('invalid-config'); } config = snapshotConfig(config); }
  catch { return fail('invalid-config'); }
  const cp = checkpoint === undefined ? undefined : readCheckpoint(checkpoint);
  if (checkpoint !== undefined && (!cp || cp.engine !== SDK_REVISION || cp.compatibility !== compatibility(config))) {return fail('checkpoint-incompatible');}
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
