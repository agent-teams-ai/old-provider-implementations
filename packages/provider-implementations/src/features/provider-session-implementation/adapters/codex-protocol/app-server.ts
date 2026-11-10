import { codexMcpConfigurationMatches } from './mcp-policy.ts'
import type { CodexMcpPolicy } from './mcp-policy.ts'
import { decodeRateLimits } from './rate-limits.ts'
import type { CodexRateLimitSnapshot } from './rate-limits.ts'
import type { CodexAppServerRequest } from '../../contracts/codex-approval.ts'
import { isCodexAppServerApprovalMethod, normalizeCodexAppServerApprovalRequest } from './approval-request.ts'
import { CodexRpcClient } from './rpc-client.ts'
import { CodexProtocolError } from './rpc-types.ts'
import type { CodexAppServerTransport, CodexRpcLimits, CodexServerReply } from './rpc-types.ts'
import type { CodexAppServerEvent, CodexApprovalHandler, CodexTurnRef } from './session-types.ts'
import { CodexThreadSession } from './thread-session.ts'
import { nativeThreadId, nativeTurnId } from './notification-mapper.ts'
import { captureModelListRequest, captureConfigReadRequest, decodeRuntimeIdentity, decodeAccountMetadata, decodeModelPage, decodeModelConfiguration } from './metadata.ts'
import type { CodexRuntimeIdentity, CodexAccountMetadata, CodexModelListRequest, CodexModelPage, CodexConfigReadRequest, CodexModelConfiguration } from './metadata.ts'
import { record, string } from './wire-frames.ts'
import { captureMcpStatusRequest, decodeMcpStatusPage } from './mcp-status.ts'
import type { CodexMcpStatusRequest, CodexMcpServerStatusPage } from './mcp-status.ts'

export type CodexAppServerOptions = {
  readonly transport: CodexAppServerTransport
  readonly onEvent: (event: CodexAppServerEvent) => void
  readonly requestApproval: CodexApprovalHandler
  /** Observation only; the existing finite request handler retains all control authority. */
  readonly onServerRequest?: () => void
  /** Attributed native item fact, including delta-only items. No permission authority is transferred. */
  readonly onItem?: (ref: CodexTurnRef, itemId: string) => void
  readonly limits?: Partial<CodexRpcLimits>
  readonly maxThreads?: number
  readonly maxQueuedTurns?: number
  readonly maxBufferedNotifications?: number
  readonly maxTextBytes?: number
}
export type CodexInitializeParams = {
  readonly clientInfo: { readonly name: string; readonly version: string; readonly title?: string }
  readonly capabilities?: Readonly<Record<string, unknown>>
}

function modelSelection(reply: Record<string, unknown> | null) {
  const model = string(reply?.model), modelProvider = string(reply?.modelProvider), cwd = string(reply?.cwd)
  return model !== null && model.length > 0 && modelProvider !== null && modelProvider.length > 0 && cwd !== null && cwd.length > 0 ? { model, modelProvider, cwd,
    ...(reply?.reasoningEffort === null || typeof reply?.reasoningEffort === 'string' ? { reasoningEffort: reply.reasoningEffort } : {}),
    ...(reply?.serviceTier === null || typeof reply?.serviceTier === 'string' ? { serviceTier: reply.serviceTier } : {}),
  } : undefined
}

function bound(value: number | undefined, fallback: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0 || result > 1_048_576) {throw new CodexProtocolError('codex.protocol.invalid-limit', 'not-sent')}
  return result
}

/** Provider-native protocol client. It has no process launcher, config store or runtime public SPI. */
export class CodexAppServerClient {
  private readonly options: CodexAppServerOptions
  private readonly rpc: CodexRpcClient
  private readonly sessions = new Map<string, CodexThreadSession>()
  private readonly maxThreads: number
  private readonly maxQueuedTurns: number
  private readonly maxBufferedNotifications: number
  private readonly maxTextBytes: number
  private initialized: Promise<void> | undefined
  private opening = 0
  private handshakeComplete = false
  private initialization: unknown

  constructor(options: CodexAppServerOptions) {
    this.options = options
    this.maxThreads = bound(options.maxThreads, 32)
    this.maxQueuedTurns = bound(options.maxQueuedTurns, 32)
    this.maxBufferedNotifications = bound(options.maxBufferedNotifications, 64)
    this.maxTextBytes = bound(options.maxTextBytes, 1_048_576)
    this.rpc = new CodexRpcClient(options.transport, {
      notification: (method, params) => { this.notification(method, params) },
      request: (request, signal) => { this.options.onServerRequest?.(); return this.approval(request, signal) },
      closed: error => { for (const session of this.sessions.values()) {session.close(error)} },
    }, options.limits)
  }

  initialize(params: CodexInitializeParams): Promise<void> {
    if (this.initialized) {return Promise.reject(new CodexProtocolError('codex.protocol.already-initialized', 'not-sent'))}
    this.initialized = this.handshake(params)
    return this.initialized
  }

  startThread(params: Readonly<Record<string, unknown>>): Promise<CodexThreadSession> {
    return this.open('thread/start', params)
  }

  resumeThread(threadId: string, params: Readonly<Record<string, unknown>> = {}): Promise<CodexThreadSession> {
    if (!threadId || this.sessions.has(threadId)) {return Promise.reject(new CodexProtocolError('codex.protocol.already-bound-thread', 'not-sent'))}
    return this.open('thread/resume', params, threadId)
  }

  /** Local detach only. The runtime must separately reconcile/stop any native work. */
  releaseThread(threadId: string): void {
    this.sessions.get(threadId)?.close()
    this.sessions.delete(threadId)
  }

  close(): void { this.rpc.close() }

  /** Protocol availability only; this does not attest provider authentication or process custody. */
  isOpen(): boolean { return this.rpc.isOpen() }

  /** Finite read-only native discovery for an actual thread owned by this client. */
  async listMcpServerStatus(supplied: CodexMcpStatusRequest, signal?: AbortSignal): Promise<CodexMcpServerStatusPage> {
    const request = captureMcpStatusRequest(supplied)
    if (!this.initialized || !this.sessions.has(request.threadId)) { throw new CodexProtocolError('codex.protocol.unbound-mcp-thread', 'not-sent') }
    await this.initialized
    const response = await this.rpc.request('mcpServerStatus/list', { ...request, detail: 'toolsAndAuthOnly' },
      { ...(signal ? { signal } : {}), beforeWrite: () => this.sessions.has(request.threadId) })
    if (!this.sessions.has(request.threadId)) { throw new CodexProtocolError('codex.protocol.unbound-mcp-thread', 'not-sent') }
    return decodeMcpStatusPage(response)
  }

  /** Selected native namespace identity, not process-custody or authentication proof. */
  getRuntimeIdentity(): CodexRuntimeIdentity {
    if (!this.handshakeComplete || !this.rpc.isOpen()) { throw new CodexProtocolError('codex.protocol.not-initialized', 'not-sent') }
    return decodeRuntimeIdentity(this.initialization)
  }

  /** Read-only: never requests token refresh, login, a thread or a turn. */
  async readAccount(signal?: AbortSignal): Promise<CodexAccountMetadata> {
    return decodeAccountMetadata(await this.nativeAccountRequest('account/read', { refreshToken: false }, signal))
  }

  /** Explicit native credential mutation. The caller must own admission, replay and process custody. */
  async refreshAccount(signal?: AbortSignal): Promise<CodexAccountMetadata> {
    return decodeAccountMetadata(await this.nativeAccountRequest('account/read', { refreshToken: true }, signal))
  }

  /** Explicit native logout; never falls back to local file deletion or a different account. */
  async logoutAccount(signal?: AbortSignal): Promise<void> {
    const response = record(await this.nativeAccountRequest('account/logout', undefined, signal))
    if (!response || Object.keys(response).length !== 0) { throw new CodexProtocolError('codex.protocol.invalid-metadata-response') }
  }

  /** Read-only account quota summary; no auth refresh or inference is requested. */
  async readAccountRateLimits(signal?: AbortSignal): Promise<CodexRateLimitSnapshot> {
    return decodeRateLimits(await this.nativeAccountRequest('account/rateLimits/read', undefined, signal))
  }

  async listModels(input: CodexModelListRequest = {}, signal?: AbortSignal): Promise<CodexModelPage> {
    const captured = captureModelListRequest(input)
    return decodeModelPage(await this.nativeAccountRequest('model/list', captured, signal), captured.limit)
  }

  /** Returns model-selection fields only; arbitrary provider config and secrets stay private. */
  async readModelConfiguration(input: CodexConfigReadRequest = {}, signal?: AbortSignal): Promise<CodexModelConfiguration> {
    const captured = captureConfigReadRequest(input)
    return decodeModelConfiguration(await this.nativeAccountRequest('config/read', captured, signal))
  }

  /** Private exact merged-MCP projection only; no raw native config escapes this adapter. */
  async matchesMcpConfiguration(policy: CodexMcpPolicy, signal?: AbortSignal): Promise<boolean> {
    return codexMcpConfigurationMatches(await this.nativeAccountRequest('config/read', {}, signal), policy)
  }

  private async nativeAccountRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.initialized) { throw new CodexProtocolError('codex.protocol.not-initialized', 'not-sent') }
    await this.initialized
    return this.rpc.request(method, params, signal ? { signal } : {})
  }

  private async handshake(params: CodexInitializeParams): Promise<void> {
    try {
      const reply = record(await this.rpc.request('initialize', params))
      this.initialization = { codexHome: reply?.codexHome, platformFamily: reply?.platformFamily, platformOs: reply?.platformOs }
      await this.rpc.notify('initialized')
      this.handshakeComplete = true
    } catch (error) {
      this.rpc.close(error instanceof CodexProtocolError ? error : new CodexProtocolError('codex.protocol.initialize-failed'))
      throw error
    }
  }

  private async open(method: 'thread/start' | 'thread/resume', params: Readonly<Record<string, unknown>>, expected?: string): Promise<CodexThreadSession> {
    if (!this.initialized) {throw new CodexProtocolError('codex.protocol.not-initialized', 'not-sent')}
    if (Object.hasOwn(params, 'threadId') || this.sessions.size + this.opening >= this.maxThreads) {
      throw new CodexProtocolError('codex.protocol.invalid-thread-params', 'not-sent')
    }
    this.opening++
    try {
      const captured = this.rpc.capture(params)
      await this.initialized
      const reply = record(await this.rpc.request(method, { ...captured, ...(expected !== undefined && expected.length > 0 ? { threadId: expected } : {}) }))
      if (!this.rpc.isOpen()) {throw new CodexProtocolError('codex.protocol.closed')}
      const threadId = string(record(reply?.thread)?.id)
      if (threadId === null || (expected !== undefined && expected.length > 0 && threadId !== expected) || this.sessions.has(threadId)) {
        this.rpc.close(new CodexProtocolError('codex.protocol.thread-identity-mismatch'))
        throw new CodexProtocolError('codex.protocol.thread-identity-mismatch')
      }
      const session = new CodexThreadSession(threadId, {
        request: (nativeMethod, nativeParams, context) => this.rpc.request(nativeMethod, nativeParams, context),
        capture: nativeParams => this.rpc.capture(nativeParams),
        event: event => { this.options.onEvent(event) }, approve: this.options.requestApproval,
        ...(this.options.onItem ? { item: this.options.onItem } : {}),
        maxQueuedTurns: this.maxQueuedTurns, maxBufferedNotifications: this.maxBufferedNotifications,
        maxTextBytes: this.maxTextBytes,
      }, modelSelection(reply))
      this.sessions.set(threadId, session)
      return session
    } finally { this.opening-- }
  }

  private notification(method: string, params: Record<string, unknown>): void {
    const threadId = nativeThreadId(params)
    // Thread lifecycle can arrive after a turn starts. It has no turn identity
    // and must never enter that turn's notification buffer or output budget.
    if (method === 'thread/started' && threadId !== null) {
      this.options.onEvent({ threadId, event: { type: 'thread_started', threadId } })
      return
    }
    if (threadId !== null && this.sessions.get(threadId)?.receive(method, params) === true) {return}
    const turnId = nativeTurnId(params)
    this.options.onEvent({
      ...(threadId !== null ? { threadId } : {}), ...(turnId !== null ? { turnId } : {}),
      event: method === 'thread/started' && threadId !== null
        ? { type: 'thread_started', threadId }
        : { type: 'unsupported_raw_event', rawType: method, payload: params },
    })
  }

  private approval(request: CodexAppServerRequest, signal: AbortSignal): Promise<CodexServerReply | null> {
    if (!isCodexAppServerApprovalMethod(request.method)) {
      return Promise.resolve({ error: { code: -32601, message: 'codex.protocol.unsupported-request' } })
    }
    const normalized = normalizeCodexAppServerApprovalRequest(request)
    const session = normalized?.threadId !== null && normalized?.threadId !== undefined ? this.sessions.get(normalized.threadId) : undefined
    return session ? session.approve(request, signal) : Promise.resolve({ error: { code: -32001, message: 'codex.protocol.unattributed-approval' } })
  }
}

export type { CodexRuntimeIdentity, CodexAccountMetadata, CodexModelListRequest, CodexModelMetadata, CodexModelPage, CodexConfigReadRequest, CodexModelConfiguration } from './metadata.ts'

export type { CodexRateLimitWindow, CodexRateLimitSnapshot } from './rate-limits.ts'
