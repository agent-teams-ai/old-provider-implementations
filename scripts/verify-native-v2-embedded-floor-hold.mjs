// Negative qualification control for the published SDK 2.0.0 Node ESM artifact.
// A failed import is NOT a model turn pass; assert it instead of hiding failure.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const path = process.env.OPENCODE_V2_EMBEDDED_RECEIPT
if (!path) throw Error('TEST_missing_floor_receipt')
const proof = JSON.parse(readFileSync(path, 'utf8'))
assert.equal(proof.kind, 'TEST_V2_EMBEDDED_DURABLE_DISCOVERY_ONLY')
assert.equal(proof.version, '2.0.0')
assert.equal(proof.qualified, false)
assert.equal(proof.completed, false)
assert.equal(proof.cleanup, true)
assert.deepEqual(proof.steps, [])
assert.equal(proof.failure, 'TEST_embedded_floor_ESM_import_unavailable')
console.log(JSON.stringify({
  negativeControl: 'sdk_2_0_0_node_esm_artifact_unusable',
  observed: true, qualified: false, cleanup: true,
}))
