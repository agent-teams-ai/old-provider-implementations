import type { CodexAppServerRequest } from '../../contracts/codex-approval.ts'

/** Connected byte transport. The runtime owns process lifetime and must honor abort. */
export interface CodexAppServerTransport {
  read(signal: AbortSignal): AsyncIterable<string | Uint8Array>
  write(frame: string, signal: AbortSignal): void | Promise<void>
}

export type CodexRpcLimits = {
  readonly maxFrameBytes: number
  readonly maxChunkBytes: number
  readonly maxDepth: number
  readonly maxPendingRequests: number
  readonly maxServerRequests: number
  readonly maxQueuedWrites: number
  readonly requestTimeoutMs: number
}

export type CodexRequestContext = {
  readonly signal?: AbortSignal
  readonly beforeWrite?: () => boolean
}

export type CodexServerReply = {
  readonly result?: Readonly<Record<string, unknown>>
  readonly error?: { readonly code: number; readonly message: string }
  readonly signal?: AbortSignal
}

export type CodexRpcHandlers = {
  readonly notification: (method: string, params: Record<string, unknown>) => void
  readonly request: (request: CodexAppServerRequest, signal: AbortSignal) => Promise<CodexServerReply | null>
  readonly closed: (error: CodexProtocolError) => void
}

export class CodexProtocolError extends Error {
  readonly code: string
  readonly acceptance: 'not-sent' | 'unknown'

  constructor(code: string, acceptance: 'not-sent' | 'unknown' = 'unknown') {
    super(code)
    this.name = 'CodexProtocolError'
    this.code = code
    this.acceptance = acceptance
  }
}

export const defaultCodexRpcLimits: CodexRpcLimits = {
  maxFrameBytes: 1_048_576,
  maxChunkBytes: 4_194_304,
  maxDepth: 32,
  maxPendingRequests: 64,
  maxServerRequests: 16,
  maxQueuedWrites: 128,
  requestTimeoutMs: 120_000,
}

export function resolveCodexRpcLimits(input: Partial<CodexRpcLimits> = {}): CodexRpcLimits {
  const limits = { ...defaultCodexRpcLimits, ...input }
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new CodexProtocolError('codex.protocol.invalid-limit', 'not-sent')
    }
  }
  return limits
}
