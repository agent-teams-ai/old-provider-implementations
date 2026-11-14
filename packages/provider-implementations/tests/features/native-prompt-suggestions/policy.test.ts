import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeClaudePromptSuggestion,
  decodeCodexPromptSuggestion,
  eligibleNativeInput,
  nativeSuggestionCandidate,
  offerNativeSuggestion,
  supportsNativeCodexSampling,
} from '../../../src/prompt-suggestions.ts';

const origin = {
  sessionRef: 'TEST-session', inputId: 'TEST-input', operationRef: 'TEST-operation',
  nativeSessionRef: 'TEST-native', nativeTurnRef: 'TEST-turn',
};

test('native suggestion is bounded, immutable and never accepts non-text controls or foreign identity', () => {
  const result = nativeSuggestionCandidate('claude', origin, '  Review the tests  ');
  assert.equal(result?.text, 'Review the tests');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(nativeSuggestionCandidate('codex', { ...origin, nativeTurnRef: undefined }, 'test'), null);
  assert.equal(nativeSuggestionCandidate('claude', origin, 'x'.repeat(513)), null);
  assert.equal(nativeSuggestionCandidate('claude', origin, '\u0000evil'), null);
  assert.equal(nativeSuggestionCandidate('claude', origin, '  '), null);
  assert.equal(nativeSuggestionCandidate('claude', { ...origin, sessionRef: '' }, 'hello'), null);
});

test('Claude SDK and Codex app-server decoders accept only exact native source identities', () => {
  assert.equal(decodeClaudePromptSuggestion({
    type: 'prompt_suggestion', session_id: 'TEST-native', suggestion: 'Continue',
  }, 'TEST-native', origin)?.text, 'Continue');
  assert.equal(decodeClaudePromptSuggestion({
    type: 'prompt_suggestion', session_id: 'TEST-other', suggestion: 'foreign',
  }, 'TEST-native', origin), null);
  assert.equal(decodeCodexPromptSuggestion({
    sourceTurnId: 'TEST-turn', responseId: 'TEST-response', text: 'Review',
  }, origin)?.text, 'Review');
  assert.equal(decodeCodexPromptSuggestion({
    sourceTurnId: 'TEST-old', responseId: 'TEST-response', text: 'stale',
  }, origin), null);
  assert.equal(decodeCodexPromptSuggestion({
    sourceTurnId: 'TEST-turn', responseId: 'TEST-response', text: null,
  }, origin), null);
  assert.equal(decodeCodexPromptSuggestion({}, origin), null);
});

test('Codex sampling refuses old/experimental-disabled/ephemeral native sessions', () => {
  assert.equal(supportsNativeCodexSampling('0.162.0', true, false), false);
  assert.equal(supportsNativeCodexSampling('0.165.0', true, false), true);
  assert.equal(supportsNativeCodexSampling('0.165.0', false, false), false);
  assert.equal(supportsNativeCodexSampling('0.165.0', true, true), false);
  assert.equal(supportsNativeCodexSampling('TEST-version', true, false), false);
});

test('Host eligibility is fail-closed and observer failures cannot affect native session', async () => {
  const binding = { eligible: () => { throw new Error('TEST-host'); },
    offer: async () => { throw new Error('TEST-observer'); } };
  assert.equal(eligibleNativeInput(binding, origin), false);
  offerNativeSuggestion(binding, nativeSuggestionCandidate('claude', origin, 'test'));
  await Promise.resolve();
  offerNativeSuggestion({ eligible: () => true, offer: () => { throw new Error('TEST-sync'); } },
    nativeSuggestionCandidate('claude', origin, 'test'));
});
