/** Explicit opt-in capability; importing this facade starts no SDK or provider. */
export {
  MAX_NATIVE_SUGGESTION_BYTES,
  CODEX_NEXT_PROMPT_SAMPLE_INSTRUCTION,
  nativeSuggestionCandidate,
  eligibleNativeInput,
  offerNativeSuggestion,
  validNativeSuggestionBinding,
  decodeClaudePromptSuggestion,
  supportsNativeCodexSampling,
  decodeCodexPromptSuggestion,
} from './features/native-prompt-suggestions/index.ts';
export type {
  NativePromptSuggestionBinding,
  NativePromptSuggestionCandidate,
  NativePromptSuggestionOrigin,
} from './features/native-prompt-suggestions/index.ts';
