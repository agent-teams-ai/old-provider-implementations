import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFrames } from '../../../../src/features/provider-session-implementation/adapters/codex-protocol/wire-frames.ts'
import { CodexProtocolError, resolveCodexRpcLimits } from '../../../../src/features/provider-session-implementation/adapters/codex-protocol/rpc-types.ts'

async function collect(chunks: readonly Uint8Array[], limits = {}) {
  const result = []
  for await (const frame of readFrames({
    async *read() { yield* chunks }, write() {},
  }, resolveCodexRpcLimits(limits), new AbortController().signal)) {result.push(frame)}
  return result
}
const bytes = (value: string) => new TextEncoder().encode(value)
const code = (value: string) => (error: unknown) => error instanceof CodexProtocolError && error.code === value

test('byte framing preserves split UTF-8 and multiple lines without accepting a truncated last frame', async () => {
  const frame = bytes('{"method":"é"}\n{"method":"second"}\n')
  assert.deepEqual(await collect([frame.slice(0, 12), frame.slice(12, 13), frame.slice(13)]), [{ method: 'é' }, { method: 'second' }])
  await assert.rejects(collect([bytes('{"method":"truncated"}')]), code('codex.protocol.truncated-frame'))
  await assert.rejects(collect([new Uint8Array([0xff, 0x0a])]), TypeError)
})

test('line/chunk/depth limits are enforced before callbacks can observe invalid frames', async () => {
  await assert.rejects(collect([bytes('x'.repeat(80))], { maxChunkBytes: 64 }), code('codex.protocol.chunk-limit'))
  await assert.rejects(collect([bytes('x'.repeat(40)), bytes('x'.repeat(40))], { maxFrameBytes: 64 }), code('codex.protocol.frame-limit'))
  await assert.rejects(collect([bytes('{"method":"x","params":{"a":{"b":1}}}\n')], { maxDepth: 2 }), code('codex.protocol.depth-limit'))
  await assert.rejects(collect([bytes('null\n')]), code('codex.protocol.invalid-envelope'))
  await assert.rejects(collect([bytes('{bad}\n')]), code('codex.protocol.invalid-json'))
})
