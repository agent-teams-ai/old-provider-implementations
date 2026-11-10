import { Buffer } from 'node:buffer'
import { CodexProtocolError } from './rpc-types.ts'
import type { CodexAppServerTransport, CodexRpcLimits } from './rpc-types.ts'

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

export function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function checkDepth(value: unknown, maxDepth: number): void {
  const pending = [{ value, depth: 0 }]
  while (pending.length) {
    const current = pending.pop()!
    if (current.depth > maxDepth) {throw new CodexProtocolError('codex.protocol.depth-limit')}
    if (current.value !== null && typeof current.value === 'object') {
      for (const child of Object.values(current.value)) {pending.push({ value: child, depth: current.depth + 1 })}
    }
  }
}

export function encodeFrame(value: unknown, limits: CodexRpcLimits): string {
  let frame: string
  try { frame = JSON.stringify(value) } catch { throw new CodexProtocolError('codex.protocol.invalid-json', 'not-sent') }
  if (!frame || Buffer.byteLength(frame, 'utf8') > limits.maxFrameBytes) {
    throw new CodexProtocolError('codex.protocol.frame-limit', 'not-sent')
  }
  try { checkDepth(JSON.parse(frame), limits.maxDepth) }
  catch (error) { throw new CodexProtocolError(error instanceof CodexProtocolError ? error.code : 'codex.protocol.invalid-json', 'not-sent') }
  return `${frame}\n`
}

export function decodeFrame(frame: string, limits: CodexRpcLimits): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(frame) } catch { throw new CodexProtocolError('codex.protocol.invalid-json') }
  checkDepth(value, limits.maxDepth)
  const message = record(value)
  if (!message || (message.jsonrpc !== undefined && message.jsonrpc !== '2.0')) {
    throw new CodexProtocolError('codex.protocol.invalid-envelope')
  }
  return message
}

/** Bytes are limited before JSON parsing; depth is checked without recursive walking. */
export async function* readFrames(
  transport: CodexAppServerTransport,
  limits: CodexRpcLimits,
  signal: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  let pendingBytes = 0
  for await (const chunk of transport.read(signal)) {
    if (signal.aborted) {return}
    const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
    if (size > limits.maxChunkBytes) {throw new CodexProtocolError('codex.protocol.chunk-limit')}
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    const parts = text.split('\n')
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!
      pendingBytes += Buffer.byteLength(part)
      if (pendingBytes > limits.maxFrameBytes) {throw new CodexProtocolError('codex.protocol.frame-limit')}
      pending += part
      if (index === parts.length - 1) {continue}
      if (pending.trim()) {yield decodeFrame(pending, limits)}
      pending = ''
      pendingBytes = 0
    }
  }
  const tail = decoder.decode()
  pending += tail
  if (pending.trim()) {throw new CodexProtocolError('codex.protocol.truncated-frame')}
}
