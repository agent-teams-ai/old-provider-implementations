import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { nativeV2ByteView } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-native-byte-view.ts'

test('native V2 byte view refuses shared backing that can race the owned copy', () => {
  const shared = new Uint8Array(new SharedArrayBuffer(4))
  shared.set([1, 2, 3, 4])
  assert.equal(nativeV2ByteView(shared), null)
})

test('native V2 byte view refuses a cross-realm shared backing with a local typed-array view', () => {
  const foreignShared = runInNewContext('new SharedArrayBuffer(4)') as SharedArrayBuffer
  const localView = new Uint8Array(foreignShared)
  assert.equal(foreignShared instanceof SharedArrayBuffer, false)
  assert.equal(localView instanceof Uint8Array, true)
  assert.equal(nativeV2ByteView(localView), null)
})

test('native V2 byte view preserves physical offsets for regular Buffer slices', () => {
  const source = Buffer.from([9, 2, 3, 4, 9])
  const view = nativeV2ByteView(source.subarray(1, 4))
  assert.ok(view)
  assert.equal(view.byteLength, 3)
  assert.deepEqual([...view], [2, 3, 4])
})

test('native V2 byte view returns refusal for revoked proxy rather than throwing', () => {
  const { proxy, revoke } = Proxy.revocable(new Uint8Array(4), {})
  revoke()
  assert.equal(nativeV2ByteView(proxy), null)
})
