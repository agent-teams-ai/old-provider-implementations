import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeV2Log } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-cut-codecs.ts'
import { projectOpenCodeV2NativeTurn } from '../../../../src/opencode.ts'
import { cut } from './v2-cut-fixture.ts'

const sessionID = 'ses_TESTemptyNative', directory = '/TEST/native-v2'
const frame = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n'
const synced = (seq: number, aggregateID = sessionID) =>
  frame({ type: 'log.synced', aggregateID, seq })
const event = (type: string, seq: number) => frame({
  id: 'evt_TEST' + seq, type,
  durable: { aggregateID: sessionID, seq },
  data: { sessionID }, location: { directory },
})

test('pinned native V2 pre-execution SSE is an empty owned cut with a valid sync watermark', () => {
  // Native OpenCode 2.0.21 TEST-owned session has no synthetic session.created
  // before first execution; its durable bus still returns one owned log.synced.
  for (const seq of [0, 7]) {
    assert.deepEqual(decodeV2Log(synced(seq), sessionID, directory), {
      events: [], synced: true, watermark: seq,
    })
  }
})

test('pre-execution empty log does not relax foreign/malformed/incomplete SSE refusal', () => {
  const cases = [
    synced(0, 'ses_foreign'),
    synced(-1),
    synced(0) + synced(1),
    synced(0).slice(0, -1),
    event('session.inbox.delivered', 9) + synced(9),
  ]
  for (const input of cases) {
    assert.throws(() => decodeV2Log(input, sessionID, directory),
      /foreign_native_log|incomplete_native_log|invalid_native_position/)
  }
})

test('durable V2 log fails closed on unsupported SSE controls or empty data frames', () => {
  const malformed = [
    'event: hidden\\n\\n' + synced(0),
    'id: hidden\\n\\n' + synced(0),
    'retry: 100\\n\\n' + synced(0),
    'data:\\n\\n' + synced(0),
    'event: hidden\\n' + synced(0),
    synced(0) + 'event: hidden\\n\\n',
    synced(0) + 'id: hidden\\n\\n',
    synced(0) + 'data:\\n\\n',
  ]
  for (const input of malformed) {
    assert.throws(() => decodeV2Log(input, sessionID, directory), /incomplete_native_log/)
  }
  assert.deepEqual(decodeV2Log(': native keepalive\\n\\n' + synced(0) + ': idle\\n\\n', sessionID, directory), {
    events: [], synced: true, watermark: 0,
  })
})

test('known nonempty session-created prefix remains valid and ordered', () => {
  assert.deepEqual(decodeV2Log(
    event('session.created', 0) + event('session.execution.started', 3) + synced(5),
    sessionID, directory,
  ), {
    events: [
      { id: 'evt_TEST0', type: 'session.created', seq: 0, aggregateID: sessionID, data: { sessionID } },
      { id: 'evt_TEST3', type: 'session.execution.started', seq: 3, aggregateID: sessionID, data: { sessionID } },
    ],
    synced: true, watermark: 5,
  })
})

test('empty synced native read cannot be projected as a completed model turn', () => {
  const source = cut()
  // This real pre-execution native SSE shape cannot certify a model response,
  // even if the message page somehow contains assistant-looking content.
  source.log.events = []
  source.log.watermark = 1
  const projected = projectOpenCodeV2NativeTurn(source)
  assert.equal(projected.state, 'unknown')
  assert.equal(projected.reason, 'missing_native_log_prefix')
})
