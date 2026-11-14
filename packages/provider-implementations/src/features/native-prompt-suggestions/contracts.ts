/** Volatile, untrusted native provider prediction. Not a user message or Session SPI event. */
export type NativePromptSuggestionCandidate = Readonly<{
  provider: 'claude' | 'codex';
  sessionRef: string;
  inputId: string;
  operationRef: string;
  nativeSessionRef: string;
  nativeTurnRef?: string;
  text: string;
}>;

/** Captured native input identity, never a product conversation or tenant locator. */
export type NativePromptSuggestionOrigin = Readonly<{
  sessionRef: string;
  inputId: string;
  operationRef: string;
  nativeSessionRef: string;
  nativeTurnRef?: string;
}>;

/** Host decides human/DM eligibility and owns publication, quota and dismissal. */
export type NativePromptSuggestionBinding = Readonly<{
  eligible: (input: Readonly<{ inputId: string; operationRef: string }>) => boolean;
  offer: (candidate: NativePromptSuggestionCandidate) => void | Promise<void>;
}>;
