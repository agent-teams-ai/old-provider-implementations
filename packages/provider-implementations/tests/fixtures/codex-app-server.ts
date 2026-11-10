import readline from 'node:readline'

type NativeMessage = { id?: string | number; method?: string; params?: Record<string, unknown> }
type Command = { id: string | number } & (
  | { kind: 'finish'; threadId: string; turnId: string; status?: string; message?: string }
  | { kind: 'notify'; method: string; params: Record<string, unknown> }
  | { kind: 'approval'; requestId: string | number; method: string; params: Record<string, unknown> }
  | { kind: 'raw'; text: string }
  | { kind: 'mcp-status'; mode: string }
  | { kind: 'metadata'; method: string; response: unknown }
  | { kind: 'hold-interrupts' | 'release-interrupts' | 'disconnect' | 'reject-next-resume' }
)

let nextThread = 0
let nextTurn = 0
let heldInterrupts = false
let rejectResume = false
let mcpMode = 'healthy', mcpReads = 0
const pendingInterrupts: NativeMessage[] = []
const metadata = new Map<string, unknown>()
const active = new Map<string, string>()
const ownedThreads = new Set<string>()
const emit = (payload: unknown) => process.stdout.write(`${JSON.stringify(payload)}\n`)
const notify = (method: string, params: Record<string, unknown>) => emit({ jsonrpc: '2.0', method, params })
const result = (id: string | number | undefined, value: unknown): void => { emit({ jsonrpc: '2.0', id, result: value }) }
const ipc = (message: unknown) => { if (process.connected) {process.send?.(message)} }
function terminal(threadId: string, turnId: string, status: string, message?: string): void {
  if (active.get(threadId) === turnId) {active.delete(threadId)}
  notify('turn/completed', { threadId, turn: { id: turnId, status, ...(message ? { error: { message } } : {}) } })
}
function mcpStatus(message: NativeMessage): void {
  const params = message.params ?? {}; mcpReads++
  if (typeof params.threadId !== 'string' || !ownedThreads.has(params.threadId) || typeof params.serverName !== 'string' || params.detail !== 'toolsAndAuthOnly') { throw new Error('fixture MCP request binding') }
  if (mcpMode === 'timeout') { return }
  if (mcpMode === 'malformed') { result(message.id, { data: 'invalid' }); return }
  if (mcpMode === 'duplicate-cursor') { result(message.id, { data: [], nextCursor: 'TEST-repeat' }); return }
  if (mcpMode === 'excessive-pages') { result(message.id, { data: [], nextCursor: 'TEST-page-' + mcpReads }); return }
  if (mcpMode === 'pagination' && params.cursor === undefined) { result(message.id, { data: [], nextCursor: 'TEST-next' }); return }
  const status = {
    name: mcpMode === 'wrong-server' ? 'foreign' : params.serverName,
    authStatus: 'unsupported', resources: [], resourceTemplates: [],
    runtimeStatus: mcpMode === 'disconnected' ? 'failed' : mcpMode === 'pending' && mcpReads === 1 ? 'starting' : 'connected',
    toolsError: mcpMode === 'tools-error' ? 'TEST-discovery-failed' : null,
    tools: mcpMode === 'wrong-tools' ? {} : { 'look-up.raw': { name: mcpMode === 'wrong-tool-name' ? 'foreign' : 'look-up.raw', inputSchema: { type: 'object' } } },
  }
  const { runtimeStatus: _runtimeStatus, ...withoutStatus } = status
  result(message.id, { data: [mcpMode === 'cached-only' ? withoutStatus : status], nextCursor: null })
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line) as NativeMessage
  ipc({ event: 'wire', message })
  if (typeof message.method !== 'string') {return}
  const params = message.params ?? {}
  if (metadata.has(message.method)) { return result(message.id, metadata.get(message.method)) }
  if (message.method === 'initialize') {return result(message.id, { userAgent: 'isolated-codex-fixture', codexHome: process.env.HOME, platformFamily: 'unix', platformOs: process.platform })}
  if (message.method === 'initialized') {return}
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (message.method === 'thread/resume' && rejectResume) {
      rejectResume = false
      emit({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'fixture.selected-thread-missing' } })
      return
    }
    const id = message.method === 'thread/resume' ? params.threadId : `thread-${++nextThread}`
    if (typeof id !== 'string') {throw new Error('fixture requires thread ID')}
    ownedThreads.add(id)
    result(message.id, { thread: { id } })
    notify('thread/started', { thread: { id } })
    return
  }
  if (message.method === 'mcpServerStatus/list') { mcpStatus(message); return }
  if (message.method === 'turn/start') {
    if (typeof params.threadId !== 'string') {throw new Error('fixture requires thread ID')}
    const id = `turn-${++nextTurn}`
    active.set(params.threadId, id)
    if (params.fixtureEarly) {
      if (params.fixtureLateThreadStarted) {notify('thread/started', { thread: { id: params.threadId } })}
      notify('turn/started', { threadId: params.threadId, turn: { id } })
      notify('item/agentMessage/delta', { threadId: params.threadId, turnId: id, itemId: 'early', delta: 'early text' })
      terminal(params.threadId, id, 'completed')
      result(message.id, { turn: { id } })
    } else {
      result(message.id, { turn: { id } })
      notify('turn/started', { threadId: params.threadId, turn: { id } })
    }
    return
  }
  if (message.method === 'turn/interrupt') {
    if (typeof params.threadId !== 'string' || typeof params.turnId !== 'string') {throw new Error('fixture requires turn identity')}
    if (heldInterrupts) {pendingInterrupts.push(message)}
    else {
      result(message.id, {})
      if (active.get(params.threadId) === params.turnId) {terminal(params.threadId, params.turnId, 'interrupted')}
    }
    return
  }
  if (message.method === 'fixture/hold') {return}
  result(message.id, {})
})

process.on('message', value => {
  const command = value as Command
  if (command.kind === 'finish') {terminal(command.threadId, command.turnId, command.status ?? 'completed', command.message)}
  if (command.kind === 'notify') {notify(command.method, command.params)}
  if (command.kind === 'approval') {emit({ jsonrpc: '2.0', id: command.requestId, method: command.method, params: command.params })}
  if (command.kind === 'raw') {process.stdout.write(command.text)}
  if (command.kind === 'metadata') {metadata.set(command.method, command.response)}
  if (command.kind === 'mcp-status') {mcpMode = command.mode; mcpReads = 0}
  if (command.kind === 'hold-interrupts') {heldInterrupts = true}
  if (command.kind === 'reject-next-resume') {rejectResume = true}
  if (command.kind === 'release-interrupts') {
    heldInterrupts = false
    for (const message of pendingInterrupts.splice(0)) {result(message.id, {})}
  }
  if (command.kind === 'disconnect') {
    ipc({ commandId: command.id, ok: true })
    process.exit(7)
  }
  ipc({ commandId: command.id, ok: true })
})
process.stdout.on('error', () => {})
ipc({ event: 'ready' })
