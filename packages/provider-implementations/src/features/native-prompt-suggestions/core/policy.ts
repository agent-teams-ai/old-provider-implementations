import type {
  NativePromptSuggestionBinding,
  NativePromptSuggestionCandidate,
  NativePromptSuggestionOrigin,
} from '../contracts.ts';

export const MAX_NATIVE_SUGGESTION_BYTES = 512;
const NON_TEXT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/** Shape and resource limits only. Product identity/authorization stay in Host. */
export function nativeSuggestionCandidate(
  provider: NativePromptSuggestionCandidate['provider'],
  origin: NativePromptSuggestionOrigin,
  rawText: unknown,
): NativePromptSuggestionCandidate | null {
  if (typeof rawText !== 'string') return null;
  const text = rawText.replace(/\r\n/gu, '\n').trim();
  if (!text || NON_TEXT_CONTROLS.test(text) || new TextEncoder().encode(text).length > MAX_NATIVE_SUGGESTION_BYTES) return null;
  if (![origin.sessionRef, origin.inputId, origin.operationRef, origin.nativeSessionRef].every(value =>
    typeof value === 'string' && value.length > 0 && value.length <= 256)) return null;
  if (provider === 'codex' && (!origin.nativeTurnRef || origin.nativeTurnRef.length > 256)) return null;
  return Object.freeze({ ...origin, provider, text });
}

export function validNativeSuggestionBinding(value: unknown): value is NativePromptSuggestionBinding {
  if (value === null || typeof value !== 'object') return false;
  const binding = value as Partial<NativePromptSuggestionBinding>;
  return typeof binding.eligible === 'function' && typeof binding.offer === 'function';
}

/** Best effort observers cannot change already recorded native execution outcomes. */
export function offerNativeSuggestion(
  binding: NativePromptSuggestionBinding | undefined,
  candidate: NativePromptSuggestionCandidate | null,
): void {
  if (!binding || !candidate) return;
  try {
    void Promise.resolve(binding.offer(candidate)).catch(() => {});
  } catch {
    // Deliberately isolated from the native Session lifecycle.
  }
}

export function eligibleNativeInput(
  binding: NativePromptSuggestionBinding | undefined,
  input: Readonly<{ inputId: string; operationRef: string }>,
): boolean {
  if (!binding) return false;
  try { return binding.eligible(input) === true; }
  catch { return false; }
}
