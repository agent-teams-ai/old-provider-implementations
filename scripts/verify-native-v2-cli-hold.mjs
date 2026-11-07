// Exact negative-control witness for the pinned stock V2 CLI. This is NOT a
// model-turn qualification; the embedded SDK with explicit event retention
// has a separate positive proof and required CI job.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const path = process.env.OPENCODE_V2_TEST_MODEL_RECEIPT
if (!path) throw Error('TEST_missing_stock_cli_receipt')
const proof = JSON.parse(readFileSync(path, 'utf8'))
assert.equal(proof.kind, 'TEST_NATIVE_V2_MODEL_BINDING_ONLY')
assert.equal(proof.qualified, false)
assert.equal(proof.completed, false)
assert.equal(proof.cleanup, true)
assert.equal(proof.failure, 'TEST_native_model_terminal_event_not_qualified')
const required = [
  'pre_execution_native_elf_version_digest_verified',
  'TEST_native_model_server_identity_verified',
  'TEST_native_local_model_selected_without_inference',
  'TEST_native_real_prompt_admitted',
  'TEST_native_fake_model_assistant_message_received',
  'TEST_native_session_outcome_and_idle_consistent',
  'TEST_native_model_cold_history_retained_without_replay',
  'TEST_native_model_session_removed',
]
for (const step of required) assert.ok(proof.steps?.includes(step), step)
assert.equal(proof.modelDiscovery?.fakeInferenceRequests, 0)
assert.equal(proof.modelTurn?.fakeFailure, null)
assert.equal(proof.modelTurn?.assistantPresent, true)
assert.ok(proof.modelTurn?.modelCalls >= 1)
assert.equal(proof.modelTurn?.sessionLog?.status, 200)
assert.equal(proof.modelTurn?.sessionLog?.synced, true)
assert.deepEqual(proof.modelTurn?.sessionLog?.visibleTypes, [])
assert.ok(Number.isSafeInteger(proof.modelTurn?.sessionLog?.watermark)
  && proof.modelTurn.sessionLog.watermark > 0)
assert.equal(proof.nativeTerminalProjection?.sessionOutcome, 'succeeded')
assert.equal(proof.nativeTerminalProjection?.inputRows, 1)
assert.equal(proof.nativeTerminalProjection?.assistantRows, 1)
assert.deepEqual(proof.nativeTerminalProjection?.idleOutcomes, ['succeeded'])
assert.equal(proof.nativeTerminalProjection?.assistantFinished, true)
assert.equal(proof.coldModelTurn?.sessionRead, 200)
assert.equal(proof.coldModelTurn?.messageRead, 200)
assert.equal(proof.coldModelTurn?.userRecords, 1)
assert.equal(proof.coldModelTurn?.preservedAssistantRecords, 1)
assert.equal(proof.coldModelTurn?.modelCallsBeforeCold, proof.coldModelTurn?.modelCallsAfterCold)
assert.equal(proof.coldModelTurn?.sessionOutcome, 'succeeded')
assert.equal(proof.coldModelTurn?.sessionIdle, proof.nativeTerminalProjection?.sessionIdle)
assert.deepEqual(proof.coldModelTurn?.idleOutcomes, ['succeeded'])
console.log(JSON.stringify({ negativeControl: 'stock_cli_no_durable_events',
  observed: true, qualified: false, cleanup: true }))
