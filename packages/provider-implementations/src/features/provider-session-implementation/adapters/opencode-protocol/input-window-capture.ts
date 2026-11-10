export type OpenCodeCaptureValue = null | boolean | number | string | readonly OpenCodeCaptureValue[] | { readonly [key: string]: OpenCodeCaptureValue }
export type OpenCodeInputWindowItem = Readonly<{ messageId: string; partId: string; callId: string; tool: string; status: string;
  input: unknown; metadata: unknown; startedAt: number | null; completedAt: number | null }>
type Identity = Readonly<{ sessionRef: string; windowRef: string; inputId: string; operationRef: string; nativeSessionId: string }>
type Gap = 'capture-failed' | 'timeout' | 'aborted' | 'transport' | 'limit'
export type OpenCodeInputWindowRequest = Readonly<Identity & { signal: AbortSignal } & (
  | { phase: 'before' }
  | { phase: 'after'; nativeInputId: string; beforeObserved: boolean; gapReason?: Gap; outcome: 'succeeded' | 'failed' | 'cancelled'; items: readonly OpenCodeInputWindowItem[] }
  | { phase: 'gap'; beforeObserved: boolean; reason: Gap }
)>
/** Private V1 input-window observation; no per-tool barrier, full-image proof or product writes. */
export interface OpenCodeInputWindowPort { observe(request: OpenCodeInputWindowRequest): void | Promise<void> }
export function snapshotOpenCodeCapture(port: OpenCodeInputWindowPort | undefined): OpenCodeInputWindowPort | undefined {
  if (port === undefined) {return}
  const receiver: unknown = port
  if (receiver === null || typeof receiver !== 'object' && typeof receiver !== 'function') {throw new Error('opencode.v1.invalid-capture')}
  const observe: unknown = Reflect.get(receiver, 'observe')
  if (typeof observe !== 'function') {throw new Error('opencode.v1.invalid-capture')}
  return Object.freeze({ observe: observe.bind(receiver) as OpenCodeInputWindowPort['observe'] })
}
type Request = OpenCodeInputWindowRequest extends infer R ? R extends OpenCodeInputWindowRequest ? Omit<R, 'signal'> : never : never
function freeze(value: unknown, depth = 0): OpenCodeCaptureValue {
  if (depth > 16) {throw new Error('capture-depth')}
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {return value}
  if (Array.isArray(value)) {return Object.freeze(value.map(item => freeze(item, depth + 1)))}
  if (value && typeof value === 'object') {return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item, depth + 1)])))}
  throw new Error('capture-value')
}
function inputWindowItem(value: unknown): value is OpenCodeInputWindowItem {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {return false}
  if (!['messageId', 'partId', 'callId', 'tool', 'status'].every(key => typeof Reflect.get(value, key) === 'string')) {return false}
  if (!['input', 'metadata'].every(key => Object.hasOwn(value, key))) {return false}
  return ['startedAt', 'completedAt'].every(key => {
    const time: unknown = Reflect.get(value, key)
    return time === null || typeof time === 'number' && Number.isFinite(time)
  })
}
function snapshotItems(serialized: string): readonly OpenCodeInputWindowItem[] {
  const items = freeze(JSON.parse(serialized))
  if (!Array.isArray(items) || !items.every(inputWindowItem)) {throw new Error('capture-item')}
  return items
}
type Options = { identity: Identity; port: OpenCodeInputWindowPort; abort: AbortSignal; timeoutMs: number; maxItems: number; maxBytes: number }
export class OpenCodeInputWindowCapture {
  private readonly options: Options
  private readonly identity: Identity
  private readonly lifetime = new AbortController()
  private observed = false
  private invalid: Gap | undefined
  private ended = false
  constructor(options: Options) {
    this.options = options
    this.identity = Object.freeze({ ...options.identity })
  }
  async before(): Promise<void> {
    const reason = await this.notify({ ...this.identity, phase: 'before' })
    if (reason) {this.gap(reason)} else if (!this.invalid && !this.ended) {this.observed = true}
  }
  async after(nativeInputId: string, outcome: 'succeeded' | 'failed' | 'cancelled', values: readonly OpenCodeInputWindowItem[]): Promise<void> {
    if (this.ended || this.options.abort.aborted) {this.gap('aborted'); return}
    let items: readonly OpenCodeInputWindowItem[] = []
    try {
      if (values.length > this.options.maxItems) {throw new Error('capture-count')}
      const serialized = JSON.stringify(values)
      if (Buffer.byteLength(serialized) > this.options.maxBytes) {throw new Error('capture-bytes')}
      items = snapshotItems(serialized)
    } catch {this.gap('limit')}
    const reason = await this.notify({ ...this.identity, phase: 'after', nativeInputId, outcome, items,
      beforeObserved: this.observed, ...(this.invalid ? { gapReason: this.invalid } : {}) }, !!this.invalid)
    if (reason) {this.gap(reason)}
    this.ended = true; this.lifetime.abort()
  }
  gap(reason: Gap): void {
    if (this.invalid || this.ended) {return}
    this.invalid = reason; this.lifetime.abort()
    // Detached diagnostic is bounded and rejection-consumed; it never delays ordinary work.
    void Promise.resolve().then(() => this.notify({ ...this.identity, phase: 'gap', beforeObserved: this.observed, reason }, true)).catch(() => {})
  }
  private async notify(request: Request, invalid = false): Promise<Gap | undefined> {
    const timeout = new AbortController()
    const signal = AbortSignal.any([timeout.signal, ...(request.phase === 'gap' ? [] : [this.options.abort, ...(invalid ? [] : [this.lifetime.signal])])])
    const timer = setTimeout(() => {timeout.abort()}, this.options.timeoutMs)
    let aborted!: () => void
    try {
      const observed = Promise.resolve(this.options.port.observe(Object.freeze({ ...request, signal }) as OpenCodeInputWindowRequest))
      await Promise.race([observed, new Promise<never>((_resolve, reject) => {
        aborted = () => {reject(new Error('capture-aborted'))}; signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) {aborted()}
      })])
      if (!signal.aborted) {return}
    } catch {if (!signal.aborted) {return 'capture-failed'}}
    finally {clearTimeout(timer); signal.removeEventListener('abort', aborted)}
    return timeout.signal.aborted ? 'timeout' : 'aborted'
  }
}
