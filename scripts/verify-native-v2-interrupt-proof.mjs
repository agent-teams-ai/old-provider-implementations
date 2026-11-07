// Positive, session-bound native SDK TEST proof only. This qualifies the
// pinned embedded active interrupt and cold no-replay, not Desktop Host
// custody, production cancellation for other engines, or shipped Electron.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const path = process.env.OPENCODE_V2_EMBEDDED_RECEIPT
if (!path) throw Error('TEST_missing_interrupt_receipt')
const proof = JSON.parse(readFileSync(path, 'utf8'))
assert.equal(proof.kind, 'TEST_V2_EMBEDDED_DURABLE_DISCOVERY_ONLY')
assert.equal(proof.version, '2.0.21')
assert.equal(proof.qualified, false, 'isolated TEST is not production admission')
assert.equal(proof.completed, true)
assert.equal(proof.cleanup, true)
assert.equal(proof.failure, undefined)
for (const step of [
  'TEST_embedded_model_durable_lineage_survived_cold_restart',
  'TEST_embedded_active_interrupt_durable_cold_no_replay',
  'TEST_embedded_session_removed',
]) assert.ok(proof.steps?.includes(step), step)
const observed = proof.interruptObservations
assert.deepEqual(observed?.terminalTypes, ['session.execution.interrupted'])
assert.equal(observed.reason, 'user')
assert.equal(observed.delivered, 1)
assert.equal(observed.modelRequests, 1)
assert.equal(observed.targetModelRequests, 1)
assert.equal(observed.socketClosed, true)
assert.equal(observed.requestProfiles?.length, 1)
assert.equal(observed.requestProfiles[0]?.targetUser, true)
assert.ok(observed.requestProfiles[0]?.roles?.includes('user'))
assert.equal(observed.requestProfiles[0]?.model, 'TEST-native-model')
const interruption = proof.nativeInterrupt
assert.equal(interruption?.active, true)
assert.equal(interruption.interrupted, true)
assert.equal(interruption.reason, 'user')
assert.equal(interruption.delivered, 1)
assert.equal(interruption.observedTargetModelRequests, 1)
assert.equal(interruption.extraAfterRestart, 0)
assert.equal(interruption.streamCancelledOnInterrupt, true)
assert.equal(interruption.streamCancelledAfterHostClose, true)
assert.equal(interruption.durableTerminalCount, 1)
assert.equal(interruption.qualified, false, 'Host integration remains HOLD')
assert.equal(proof.interruptAfterHostClose?.socketClosed, true)
console.log(JSON.stringify({ test: 'pinned_sdk_active_interrupt_stream_cancelled_and_no_replay',
  verified: true, productionQualified: false, cleanup: true }))
