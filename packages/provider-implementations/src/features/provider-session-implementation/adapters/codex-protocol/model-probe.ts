import { codexModelOptionArgs } from './model-options.ts'
import { CodexProtocolError } from './rpc-types.ts'
import type { CodexAppServerTransport } from './rpc-types.ts'
import { CodexAppServerClient } from './app-server.ts'
import { bounded } from '../provider-session-io/io.ts'
import { captureCodexModelProbe } from './model-probe-config.ts'
import type { CodexModelProbeConfig, CodexModelProbeConnection } from './model-probe-config.ts'
import type { CodexAppServerEvent, CodexTurnRef } from './session-types.ts'

type Fact = { threadId?: string; turnId?: string; type: string; text?: string }
const allowed = new Set(['thread_started', 'turn_started', 'assistant_text', 'usage_updated', 'turn_completed', 'turn_failed', 'turn_interrupted'])
function observations() {
  const facts: Fact[] = []; let bytes = 0; let invalid = false
  return {
    onEvent(event: CodexAppServerEvent): void {
      bytes += Buffer.byteLength(JSON.stringify(event))
      if (!allowed.has(event.event.type)) {invalid = true}
      if (facts.length >= 256 || bytes > 512 * 1024) {invalid = true; return}
      facts.push({ ...(event.threadId !== undefined && event.threadId.length > 0 ? { threadId: event.threadId } : {}), ...(event.turnId !== undefined && event.turnId.length > 0 ? { turnId: event.turnId } : {}),
        type: event.event.type, ...(event.event.type === 'assistant_text' ? { text: event.event.text } : {}) })
    },
    reject(): void { invalid = true },
    valid(ref: CodexTurnRef): boolean { return !invalid && facts.some(fact => fact.threadId === ref.threadId && fact.turnId === ref.turnId && fact.type === 'assistant_text' && fact.text !== undefined && fact.text.trim().length > 0) },
  }
}
function readPort(value: unknown): value is CodexAppServerTransport['read'] { return typeof value === 'function' }
function writePort(value: unknown): value is CodexAppServerTransport['write'] { return typeof value === 'function' }
function connection(value: CodexModelProbeConnection, retain: (dispose: () => Promise<boolean>) => void): CodexModelProbeConnection {
  // Snapshot callable ports once, never resolve or adopt a later native process.
  const dispose = value.dispose
  if (typeof dispose !== 'function') {throw new Error('codex.probe.invalid-connection')}
  const capturedDispose = dispose.bind(value)
  retain(capturedDispose)
  const transport = value.transport
  const read: unknown = Reflect.get(transport, 'read'), write: unknown = Reflect.get(transport, 'write')
  if (!readPort(read) || !writePort(write)) {throw new Error('codex.probe.invalid-connection')}
  return { transport: { read: read.bind(transport), write: write.bind(transport) }, dispose: capturedDispose }
}

async function infer(client: CodexAppServerClient, captured: CodexModelProbeConfig, observed: ReturnType<typeof observations>, current: () => boolean, signal: AbortSignal): Promise<boolean> {
  await client.initialize({ clientInfo: { name: 'codex-model-probe', version: '1' } })
  if (client.getRuntimeIdentity().codexHome !== captured.environment.CODEX_HOME) {throw new Error('codex.probe.namespace-mismatch')}
  const thread = await client.startThread({ cwd: captured.cwd, model: captured.model, ...(captured.modelProvider !== undefined && captured.modelProvider.length > 0 ? { modelProvider: captured.modelProvider } : {}), approvalPolicy: 'never', sandbox: 'read-only' })
  const proof = thread.modelSelection
  if (proof?.model === captured.model && proof.cwd === captured.cwd &&
    (captured.modelProvider === undefined || proof.modelProvider === captured.modelProvider) &&
    (captured.reasoningEffort === undefined || proof.reasoningEffort === captured.reasoningEffort) &&
    (captured.fastMode !== true || proof.serviceTier === 'fast')) {
    if (!current()) {throw new Error('codex.probe.cancelled')}
    const turn = thread.submitTurn({ ...(captured.reasoningEffort === undefined ? {} : { effort: captured.reasoningEffort }), input: [{ type: 'text', text: 'Reply only OK. Do not use tools, access files or run commands.', text_elements: [] }] }, signal)
    const ref = await turn.accepted, terminal = await turn.completed
    if (terminal.outcome === 'unknown') {throw new Error('codex.probe.unknown')}
    if (!current()) {throw new Error('codex.probe.cancelled')}
    return terminal.outcome === 'completed' && observed.valid(ref)
  }
  return false
}

function signalAborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true }

function failure(error: unknown, aborted: boolean): string {
  if (aborted) {return 'codex.probe.cancelled'}
  if (error instanceof Error && ['codex.probe.unknown', 'codex.probe.cancelled', 'codex.probe.namespace-mismatch'].includes(error.message)) {return error.message}
  if (error instanceof CodexProtocolError && error.acceptance === 'unknown') {return 'codex.probe.unknown'}
  return 'codex.probe.unavailable'
}

/** Exactly one selected, read-only no-tools-output inference. No retries, recovery, product state or agent loop. */
export async function probeCodexModel(selected: CodexModelProbeConfig, signal?: AbortSignal): Promise<boolean> {
  const captured = captureCodexModelProbe(selected)
  const authorized = () => { try { const answer: unknown = captured.canSubmit(); return answer === true } catch { return false } }
  if (signal?.aborted === true || !authorized()) {throw new Error('codex.probe.cancelled')}
  const stop = new AbortController()
  const current = () => !stop.signal.aborted && signal?.aborted !== true && authorized()
  let client: CodexAppServerClient | undefined, dispose: (() => Promise<boolean>) | undefined
  let reason: string | undefined, result = false, timer: ReturnType<typeof setTimeout> | undefined
  const abort = () => { stop.abort(); client?.close() }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    timer = setTimeout(() => { reason = 'codex.probe.timeout'; abort() }, captured.timeoutMs)
    const owned = connection(captured.launch(Object.freeze({ command: captured.executablePath, args: Object.freeze([...codexModelOptionArgs(captured), 'app-server', '--listen', 'stdio://']), cwd: captured.cwd, env: captured.environment, signal: stop.signal })), capturedDispose => {dispose = capturedDispose})
    if (!current()) {throw new Error('codex.probe.cancelled')}
    const observed = observations()
    const transport = owned.transport
    client = new CodexAppServerClient({ transport: { read: readSignal => transport.read(readSignal), write(frame, requestSignal) {
      if (!current() || requestSignal.aborted) {throw new Error('codex.probe.cancelled')}
      return transport.write(frame, requestSignal)
    } }, onEvent: event => {observed.onEvent(event)}, onServerRequest: () => {observed.reject()}, requestApproval: async request => ({ kind: 'decision', decision: request.method === 'execCommandApproval' || request.method === 'applyPatchApproval' ? 'denied' : 'decline' }),
      limits: { requestTimeoutMs: captured.timeoutMs, maxPendingRequests: 8, maxServerRequests: 8, maxQueuedWrites: 16 }, maxThreads: 1, maxQueuedTurns: 1,
      maxBufferedNotifications: 64, maxTextBytes: 512 * 1024 })
    result = await infer(client, captured, observed, current, stop.signal)
  } catch (error) {
    reason ??= failure(error, stop.signal.aborted || signalAborted(signal))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort); stop.abort(); client?.close()
    if (dispose) {
      try {if (!await bounded(dispose(), Math.min(captured.timeoutMs, 5000))) {reason = 'codex.probe.cleanup-unconfirmed'}}
      catch {reason = 'codex.probe.cleanup-unconfirmed'}
    }
  }
  if (reason !== undefined && reason.length > 0) {throw new Error(reason)}
  return result
}
