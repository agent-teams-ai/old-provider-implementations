import type { NativePromptSuggestionCandidate, NativePromptSuggestionOrigin } from '../contracts.ts';
import { nativeSuggestionCandidate } from '../core/policy.ts';

/** Sent only to a captured, owned, idle persistent root App Server thread. */
export const CODEX_NEXT_PROMPT_SAMPLE_INSTRUCTION =
  'Predict the next message the user will send in this conversation. Reply with only that message, in under 20 words. Do not use tools. If there is no clear next step, reply with nothing.';

/** 0.162.0 is our old pinned protocol and has no qualified thread/sample support. */
export function supportsNativeCodexSampling(protocolRevision: string, experimentalApi: boolean, ephemeral: boolean): boolean {
  if (!experimentalApi || ephemeral) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(protocolRevision);
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]);
  return major === 0 && minor >= 165;
}

/** Validates native response identity, no string fabrication on missing/tool outputs. */
export function decodeCodexPromptSuggestion(
  response: unknown,
  origin: NativePromptSuggestionOrigin,
): NativePromptSuggestionCandidate | null {
  if (response === null || typeof response !== 'object') return null;
  const data = response as Record<string, unknown>;
  if (data.sourceTurnId !== origin.nativeTurnRef || typeof data.responseId !== 'string' || !data.responseId) return null;
  return nativeSuggestionCandidate('codex', origin, data.text);
}
