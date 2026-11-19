import type { NativePromptSuggestionCandidate, NativePromptSuggestionOrigin } from '../contracts.ts';
import { nativeSuggestionCandidate } from '../core/policy.ts';

/** Reads the SDK's push event, never generates or launches a new Claude Query. */
export function decodeClaudePromptSuggestion(
  nativeMessage: unknown,
  expectedNativeSession: string,
  origin: NativePromptSuggestionOrigin,
): NativePromptSuggestionCandidate | null {
  if (nativeMessage === null || typeof nativeMessage !== 'object') return null;
  const frame = nativeMessage as Record<string, unknown>;
  if (frame.type !== 'prompt_suggestion' || frame.session_id !== expectedNativeSession ||
      origin.nativeSessionRef !== expectedNativeSession) return null;
  return nativeSuggestionCandidate('claude', origin, frame.suggestion);
}
