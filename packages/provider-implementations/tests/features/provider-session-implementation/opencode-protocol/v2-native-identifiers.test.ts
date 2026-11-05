import assert from 'node:assert/strict'
import { test } from 'node:test'
import { safeV2MessageID, safeV2SessionID } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-native-identifiers.ts'

test('native session and message identifiers preserve safe OpenCode V2 URL-segment separators', () => {
  for (const valid of ['TESTid', 'TEST-safe_1', 'A'.repeat(256)]) {
    assert.equal(safeV2SessionID('ses_' + valid), true)
    assert.equal(safeV2MessageID('msg_' + valid), true)
  }
})
test('native identifiers reject foreign URL delimiters, empty segments, controls and unbounded captures', () => {
  for (const invalid of ['', 'foreign', 'test/path', 'test?x=1', 'test#fragment', 'test%2Fescape',
    'test\\\\backslash', 'test space', 'A'.repeat(257)]) {
    assert.equal(safeV2SessionID('ses_' + invalid), false, invalid)
    assert.equal(safeV2MessageID('msg_' + invalid), false, invalid)
  }
  assert.equal(safeV2SessionID('msg_TEST'), false)
  assert.equal(safeV2MessageID('ses_TEST'), false)
  assert.equal(safeV2SessionID(null), false)
  assert.equal(safeV2MessageID(undefined), false)
})
