// Expected negative control for the exact pinned V2.0.21 SDK interrupt
// transport. Native interruption is durable, but the TEST model HTTP response
// does not close within the bounded grace period. This is a STOP-SHIP HOLD,
// not a successful active-cancellation or Host qualification.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const path = process.env.OPENCODE_V2_EMBEDDED_RECEIPT
if (!path) throw Error('TEST_missing_interrupt_receipt')
const proof = JSON.parse(readFileSync(path, 'utf8'))
assert.equal(proof.kind, 'TEST_V2_EMBEDDED_DURABLE_DISCOVERY_ONLY')
assert.equal(proof.version, '2.0.21')
assert.equal(proof.qualified, false)
assert.equal(proof.completed, false)
assert.equal(proof.cleanup, true)
assert.equal(proof.failure, 'TEST_active_interrupt_http_stream_not_cancelled')
assert.ok(proof.steps?.includes('TEST_embedded_model_durable_lineage_survived_cold_restart'))
assert.ok(proof.steps?.includes('TEST_embedded_active_interrupt_durable_cold_no_replay'))
assert.equal(proof.nativeInterrupt?.extraAfterRestart, 0)
assert.equal(proof.nativeInterrupt?.streamCancelledOnInterrupt, false)
assert.equal(proof.nativeInterrupt?.streamCancelledAfterHostClose, true)
assert.deepEqual(proof.interruptObservations?.terminalTypes, ['session.execution.interrupted'])
assert.equal(proof.interruptObservations?.reason, 'user')
assert.equal(proof.interruptObservations?.delivered, 1)
assert.ok(Number.isInteger(proof.interruptObservations?.modelRequests) &&
  proof.interruptObservations.modelRequests >= 1)
assert.equal(proof.interruptObservations?.socketClosed, false)
console.log(JSON.stringify({
  negativeControl: 'pinned_embedded_active_interrupt_stream_not_closed',
  durableInterruptObserved: true, transportCancellationUnqualified: true,
  qualified: false, cleanup: true,
}))
