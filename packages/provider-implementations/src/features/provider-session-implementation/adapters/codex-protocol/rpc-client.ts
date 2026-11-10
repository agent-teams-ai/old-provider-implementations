import type { CodexAppServerRequestId } from '../../contracts/codex-approval.ts'
import { CodexProtocolError, resolveCodexRpcLimits } from './rpc-types.ts'
import type { CodexAppServerTransport, CodexRequestContext, CodexRpcHandlers, CodexRpcLimits, CodexServerReply } from './rpc-types.ts'
import { decodeFrame, encodeFrame, readFrames, record, string } from './wire-frames.ts'

type Pending = {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: CodexProtocolError) => void
  readonly cleanup: () => void
  sent: boolean
}

function isId(value: unknown): value is CodexAppServerRequestId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))
}

/** JSON-RPC bookkeeping only. Never starts, kills, reconnects or replays a process. */
export class CodexRpcClient {
  readonly limits: CodexRpcLimits
  private readonly transport: CodexAppServerTransport
  private readonly handlers: CodexRpcHandlers
  private readonly abort = new AbortController()
  private readonly pending = new Map<CodexAppServerRequestId, Pending>()
  private readonly serverRequests = new Map<CodexAppServerRequestId, AbortController>()
  private writes: Promise<void> = Promise.resolve()
  private queuedWrites = 0
  private nextId = 0
  private ended = false

  constructor(
    transport: CodexAppServerTransport,
    handlers: CodexRpcHandlers,
    limits: Partial<CodexRpcLimits> = {},
  ) {
    this.transport = transport
    this.handlers = handlers
    this.limits = resolveCodexRpcLimits(limits)
    void this.read()
  }

  isOpen(): boolean { return !this.ended }

  close(error = new CodexProtocolError('codex.protocol.closed')): void {
    if (this.ended) {return}
    this.ended = true // Seal synchronously before any callbacks or queued writes.
    this.abort.abort(error)
    for (const entry of this.pending.values()) {
      entry.cleanup()
      entry.reject(new CodexProtocolError(error.code, entry.sent ? 'unknown' : 'not-sent'))
    }
    this.pending.clear()
    for (const controller of this.serverRequests.values()) {controller.abort(error)}
    this.serverRequests.clear()
    this.handlers.closed(error)
  }

  request(method: string, params: unknown, context: CodexRequestContext = {}): Promise<unknown> {
    if (this.ended || context.signal?.aborted === true) {return Promise.reject(new CodexProtocolError('codex.protocol.closed', 'not-sent'))}
    if (this.pending.size >= this.limits.maxPendingRequests) {return Promise.reject(new CodexProtocolError('codex.protocol.pending-limit', 'not-sent'))}
    const id = `client:${++this.nextId}`
    // Capture caller parameters at invocation, before the queued write may run.
    const frame = encodeFrame({ jsonrpc: '2.0', id, method, params }, this.limits)
    return new Promise((resolve, reject) => {
      const fail = (code: string): void => {
        const entry = this.pending.get(id)
        if (!entry) {return}
        entry.cleanup()
        this.pending.delete(id)
        reject(new CodexProtocolError(code, entry.sent ? 'unknown' : 'not-sent'))
      }
      const cancel = (): void => { fail('codex.protocol.request-aborted') }
      const timer = setTimeout(() => { fail('codex.protocol.request-timeout') }, this.limits.requestTimeoutMs)
      const entry: Pending = {
        resolve, reject, sent: false,
        cleanup: () => { clearTimeout(timer); context.signal?.removeEventListener('abort', cancel) },
      }
      this.pending.set(id, entry)
      context.signal?.addEventListener('abort', cancel, { once: true })
      void this.write(frame, context, () => {
        if (!this.pending.has(id)) {throw new CodexProtocolError('codex.protocol.request-expired', 'not-sent')}
        entry.sent = true
      }).catch((error: unknown) => { fail(error instanceof CodexProtocolError ? error.code : 'codex.protocol.transport-lost') })
      if (context.signal?.aborted === true) {cancel()}
    })
  }

  notify(method: string): Promise<void> {
    return this.write(encodeFrame({ jsonrpc: '2.0', method }, this.limits))
  }

  private write(frame: string, context: CodexRequestContext = {}, onSend?: () => void): Promise<void> {
    if (this.ended || context.signal?.aborted === true) {return Promise.reject(new CodexProtocolError('codex.protocol.closed', 'not-sent'))}
    if (this.queuedWrites >= this.limits.maxQueuedWrites) {return Promise.reject(new CodexProtocolError('codex.protocol.write-limit', 'not-sent'))}
    this.queuedWrites++
    const write = this.writes.then(async () => {
      if (this.ended || context.signal?.aborted === true || context.beforeWrite?.() === false) {
        throw new CodexProtocolError('codex.protocol.stale-write', 'not-sent')
      }
      onSend?.()
      try {
        // Once dispatch begins, finish the atomic frame. A local request abort cannot unsend it.
        await this.transport.write(frame, this.abort.signal)
        return
      } catch {
        this.close(new CodexProtocolError('codex.protocol.transport-lost'))
        throw new CodexProtocolError('codex.protocol.transport-lost')
      }
    })
    this.writes = write.catch((error: unknown) => {
      if (!(error instanceof CodexProtocolError)) {this.close(new CodexProtocolError('codex.protocol.transport-lost'))}
      return
    }).finally(() => { this.queuedWrites-- })
    return write
  }

  private async read(): Promise<void> {
    try {
      for await (const message of readFrames(this.transport, this.limits, this.abort.signal)) {this.receive(message)}
      if (!this.ended) {this.close(new CodexProtocolError('codex.protocol.transport-lost'))}
    } catch (error) {
      if (!this.ended) {this.close(error instanceof CodexProtocolError ? error : new CodexProtocolError('codex.protocol.transport-lost'))}
    }
  }

  private receive(message: Record<string, unknown>): void {
    if (this.ended) {return}
    const hasId = Object.hasOwn(message, 'id')
    if (hasId && !isId(message.id)) {throw new CodexProtocolError('codex.protocol.invalid-id')}
    const method = string(message.method)
    if (Object.hasOwn(message, 'method') && method === null) {throw new CodexProtocolError('codex.protocol.invalid-method')}
    if (method !== null) {
      const params = message.params === undefined ? {} : record(message.params)
      if (!params) {throw new CodexProtocolError('codex.protocol.invalid-params')}
      if (hasId && isId(message.id)) {void this.handleServerRequest(message.id, method, params)}
      else {this.handlers.notification(method, params)}
      return
    }
    if (!hasId || !isId(message.id)) {throw new CodexProtocolError('codex.protocol.invalid-envelope')}
    const entry = this.pending.get(message.id)
    if (!entry) {return} // Late/duplicate replies cannot revive a completed request.
    if (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) {throw new CodexProtocolError('codex.protocol.invalid-response')}
    entry.cleanup()
    this.pending.delete(message.id)
    if (Object.hasOwn(message, 'error')) {entry.reject(new CodexProtocolError('codex.protocol.provider-error'))}
    else {entry.resolve(message.result)}
  }

  private async handleServerRequest(id: CodexAppServerRequestId, method: string, params: Record<string, unknown>): Promise<void> {
    if (this.serverRequests.has(id) || this.serverRequests.size >= this.limits.maxServerRequests) {
      this.close(new CodexProtocolError('codex.protocol.server-request-limit'))
      return
    }
    const abort = new AbortController()
    this.serverRequests.set(id, abort)
    try {
      const reply = await this.handlers.request({ id, method, params }, abort.signal)
      if (this.ended || abort.signal.aborted || !reply) {return}
      await this.writeReply(id, reply)
    } catch {
      if (!this.ended && !abort.signal.aborted) {
        try { await this.writeReply(id, { error: { code: -32000, message: 'codex.protocol.request-rejected' } }) } catch { /* closed or stale */ }
      }
    } finally {
      if (this.serverRequests.get(id) === abort) {this.serverRequests.delete(id)}
    }
  }

  private writeReply(id: CodexAppServerRequestId, reply: CodexServerReply): Promise<void> {
    return this.write(encodeFrame({ jsonrpc: '2.0', id, ...(reply.error ? { error: reply.error } : { result: reply.result }) }, this.limits), reply.signal ? { signal: reply.signal } : {})
  }

  /** Bounded deep copy for queued native request data, with no ambient configuration. */
  capture(params: Readonly<Record<string, unknown>>): Record<string, unknown> {
    return decodeFrame(encodeFrame(params, this.limits).trimEnd(), this.limits)
  }
}
