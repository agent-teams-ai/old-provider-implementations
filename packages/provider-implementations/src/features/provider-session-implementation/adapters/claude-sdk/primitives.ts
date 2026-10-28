import type { Failure, FailureCode } from '@agent-teams/provider-session-contracts';
export const fail = (code: FailureCode): Failure => ({ ok: false, code });
