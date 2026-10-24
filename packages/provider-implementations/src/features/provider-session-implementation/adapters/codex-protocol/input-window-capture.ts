import type { CodexAppServerEvent, CodexTurnOutcome } from './session-types.ts'

export type CodexCaptureValue = null | boolean | number | string | readonly CodexCaptureValue[] | { readonly [key: string]: CodexCaptureValue }
type Identity = { readonly sessionRef: string; readonly windowRef: string; readonly inputId: string; readonly operationRef: string; readonly threadId: string }
export type CodexInputWindowItem = Readonly<{ itemId: string; phase: 'started' | 'completed'; status: string; changes: CodexCaptureValue }>
type GapReason = 'capture-failed' | 'timeout' | 'aborted' | 'transport' | 'limit' | 'conflict'
export type CodexInputWindowRequest = Readonly<Identity & { signal: AbortSignal } & (
  | { phase: 'before' }
  | { phase: 'after'; turnId: string; beforeObserved: boolean; gapReason?: GapReason; outcome: CodexTurnOutcome['outcome']; items: readonly CodexInputWindowItem[] }
  | { phase: 'gap'; turnId?: string; beforeObserved: boolean; reason: GapReason }
)>
/** Optional private provider observations, never native permissions or a product writer. */
export interface CodexInputWindowPort {
  observe(request: CodexInputWindowRequest): void | Promise<void>
}
function observer(value: unknown): value is CodexInputWindowPort['observe'] { return typeof value === 'function' }
function serializeChanges(value: unknown): unknown { return JSON.stringify(value) }
export function snapshotInputWindowPort(port: CodexInputWindowPort | undefined): CodexInputWindowPort | undefined {
  if (port === undefined) {return}
  const candidate: unknown = port
  const observe: unknown = candidate !== null && (typeof candidate === 'object' || typeof candidate === 'function') ? Reflect.get(candidate, 'observe') : undefined
  if (!observer(observe)) {throw new Error('codex.driver.invalid-capture')}
  return Object.freeze({ observe: observe.bind(port) })
}
type WithoutSignal = CodexInputWindowRequest extends infer R ? R extends CodexInputWindowRequest ? Omit<R, 'signal'> : never : never

function freezeCapture(value: unknown, depth = 0): CodexCaptureValue {
  if (depth > 16) {throw new Error('capture limit')}
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {return value}
  if (Array.isArray(value)) {return Object.freeze(value.map(item => freezeCapture(item, depth + 1)))}
  if (value && typeof value === 'object') {return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeCapture(item, depth + 1)])))}
  throw new Error('capture value')
}

/** Exactly one original input; no durable state, native effects, queue or replay. */
export class CodexInputWindowCapture {
  private readonly identity: Identity
  private readonly port: CodexInputWindowPort
  private readonly timeoutMs: number
  private readonly abort: AbortSignal
  private readonly maxItems: number
  private readonly maxBytes: number
  private readonly items: CodexInputWindowItem[] = []
  private readonly lifetime = new AbortController()
  private bytes = 0
  private prepared = false
  private ended = false
  private invalid: GapReason | undefined
  private nativeTurn: string | undefined
  private gapFlight: Promise<unknown> | undefined
  constructor(options: { identity: Identity; port: CodexInputWindowPort; abort: AbortSignal; timeoutMs: number; maxItems: number; maxBytes: number }) {
    this.identity = Object.freeze({ ...options.identity }); this.port = options.port
    this.timeoutMs = options.timeoutMs
    this.abort = options.abort; this.maxItems = options.maxItems; this.maxBytes = options.maxBytes
  }
  private available(): boolean { return !this.ended && this.invalid === undefined }
  async before(): Promise<void> {
    if (this.prepared || this.ended || this.invalid) {return}
    const reason = await this.notify({ ...this.identity, phase: 'before' })
    if (reason) {this.gap(reason)}
    else if (this.available()) {this.prepared = true}
  }
  record(event: CodexAppServerEvent): void {
    if (!this.prepared || this.ended || this.invalid || this.abort.aborted || event.threadId !== this.identity.threadId || typeof event.turnId !== 'string' || event.turnId.length === 0) {return}
    const raw = event.event
    if ((raw.type !== 'tool_call_started' && raw.type !== 'tool_call_completed') || raw.rawItemType !== 'fileChange') {return}
    if (this.nativeTurn !== undefined && this.nativeTurn !== event.turnId) {this.gap('conflict'); return}
    this.nativeTurn = event.turnId
    try {
      const serialized = serializeChanges(raw.arguments.changes)
      if (typeof serialized !== 'string' || this.items.length >= this.maxItems || this.bytes + Buffer.byteLength(serialized) > this.maxBytes) {this.gap('limit'); return}
      const changes: unknown = JSON.parse(serialized)
      if (!Array.isArray(changes)) {this.gap('conflict'); return}
      const item = Object.freeze({ itemId: raw.itemId, phase: raw.type === 'tool_call_started' ? 'started' as const : 'completed' as const,
        status: raw.status, changes: freezeCapture(changes) })
      this.bytes += Buffer.byteLength(serialized); this.items.push(item)
    } catch {this.gap('limit')}
  }
  async after(terminal: CodexTurnOutcome): Promise<void> {
    if (this.ended) {return}
    if (this.abort.aborted) {this.gap('aborted'); return}
    if (terminal.threadId !== this.identity.threadId || (this.nativeTurn !== undefined && terminal.turnId !== this.nativeTurn)) {this.gap('conflict'); return}
    this.nativeTurn = terminal.turnId
    const reason = await this.notify({ ...this.identity, phase: 'after', turnId: terminal.turnId,
      beforeObserved: this.prepared, ...(this.invalid ? { gapReason: this.invalid } : {}),
      outcome: terminal.outcome, items: Object.freeze([...this.items]) }, false, !!this.invalid)
    if (reason) {this.gap(reason)}
    this.ended = true
  }
  gap(reason: GapReason): void {
    if (this.gapFlight) {return}
    if (this.ended) {return}
    // Invalidate synchronously. Notification is best effort, never another work barrier.
    this.invalid = reason; this.lifetime.abort()
    this.gapFlight = Promise.resolve().then(() => this.notify({ ...this.identity, phase: 'gap', beforeObserved: this.prepared,
      ...(this.nativeTurn === undefined ? {} : { turnId: this.nativeTurn }), reason }, true)).then(() => null)
  }
  private async notify(request: WithoutSignal, gap = false, invalid = false): Promise<GapReason | undefined> {
    const timeout = new AbortController()
    const signal = AbortSignal.any([timeout.signal, ...(gap ? [] : [this.abort, ...(invalid ? [] : [this.lifetime.signal])])])
    const timer = setTimeout(() => {timeout.abort()}, this.timeoutMs)
    let aborted!: () => void
    try {
      const observed = Promise.resolve(this.port.observe(Object.freeze({ ...request, signal }) as CodexInputWindowRequest))
      await Promise.race([observed, new Promise<never>((_resolve, reject) => {
        aborted = () => {reject(new Error('Capture aborted'))}
        signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) {aborted()}
      })])
      if (!signal.aborted) {return}
    } catch {if (!signal.aborted) {return 'capture-failed'}}
    finally {clearTimeout(timer); signal.removeEventListener('abort', aborted)}
    return timeout.signal.aborted ? 'timeout' : 'aborted'
  }
}
