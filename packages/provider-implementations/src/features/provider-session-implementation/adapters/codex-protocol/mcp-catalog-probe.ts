import { z } from 'zod'
import { bounded } from '../provider-session-io/io.ts'
import { decodeCodexConfiguredMcpCatalog } from './mcp-catalog.ts'
import type { CodexConfiguredMcpCatalog } from './mcp-catalog.ts'

export type CodexMcpCatalogLaunch = Readonly<{ command: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>>; signal: AbortSignal }>
/** Consumer retains the exact child handle; terminal is its actual exit, never stdout EOF. */
export type CodexMcpCatalogConnection = { read: () => AsyncIterable<Uint8Array>; terminal: Promise<Readonly<{ exitCode: number | null; signal: string | null }>>; dispose: () => Promise<boolean> }
export type CodexMcpCatalogConfig = {
  executablePath: string; cwd: string; environment: Record<string, string>; timeoutMs: number
  launch: (request: CodexMcpCatalogLaunch) => CodexMcpCatalogConnection
  canRead: () => boolean
}
const path = z.string().min(1).max(8192).startsWith('/').refine(value => !/[\0\r\n]/u.test(value))
const schema = z.object({ executablePath: path, cwd: path,
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string().max(65536)).refine(value => Object.keys(value).length <= 256),
  timeoutMs: z.number().int().min(1).max(180000),
  launch: z.custom<CodexMcpCatalogConfig['launch']>(value => typeof value === 'function'), canRead: z.custom<() => boolean>(value => typeof value === 'function'),
}).strict().refine(value => path.safeParse(value.environment.HOME).success && path.safeParse(value.environment.CODEX_HOME).success)
function terminalPromise(value: unknown): value is CodexMcpCatalogConnection['terminal'] {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof Reflect.get(value, 'then') === 'function'
}
/** Exactly one native metadata command; HTTP rows may fetch OAuth metadata with GET.
 * No thread, turn, login, MCP initialize/tool call, header-helper execution or retry. */
export async function readCodexConfiguredMcpCatalog(selected: CodexMcpCatalogConfig, signal?: AbortSignal): Promise<CodexConfiguredMcpCatalog> {
  let captured: CodexMcpCatalogConfig
  try { const parsed = schema.parse({ ...selected }); captured = { ...parsed, environment: Object.freeze({ ...parsed.environment }), launch: parsed.launch.bind(selected), canRead: parsed.canRead.bind(selected) } }
  catch { throw new Error('codex.mcp.invalid-config') }
  const authorized = () => { try { const answer: unknown = captured.canRead(); return answer === true } catch { return false } }
  if (signal?.aborted === true || !authorized()) { throw new Error('codex.mcp.cancelled') }
  const stop = new AbortController(), deadline = AbortSignal.timeout(captured.timeoutMs)
  const current = () => !stop.signal.aborted && !deadline.aborted && signal?.aborted !== true && authorized()
  const combined = AbortSignal.any([stop.signal, deadline, ...(signal ? [signal] : [])])
  let dispose: (() => Promise<boolean>) | undefined, result: CodexConfiguredMcpCatalog | undefined, reason: string | undefined
  try {
    const owned = captured.launch(Object.freeze({ command: captured.executablePath, args: Object.freeze(['mcp', 'list', '--json']), cwd: captured.cwd, env: captured.environment, signal: combined }))
    const cleanup = owned.dispose
    if (typeof cleanup !== 'function') { throw new Error('invalid') }
    dispose = cleanup.bind(owned)
    const read = owned.read
    const terminal: unknown = owned.terminal
    if (typeof read !== 'function' || !terminalPromise(terminal)) { throw new Error('invalid') }
    const observe = async () => {
      const chunks: Buffer[] = []; let bytes = 0
      for await (const chunk of read.call(owned)) {
        if (!current() || !(chunk instanceof Uint8Array)) { throw new Error('invalid') }
        bytes += chunk.byteLength
        if (bytes > 1_048_576) { throw new Error('invalid') }
        chunks.push(Buffer.from(chunk))
      }
      const ended = await terminal
      if (!current() || ended.exitCode !== 0 || ended.signal !== null) { throw new Error('invalid') }
      return decodeCodexConfiguredMcpCatalog(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    }
    result = await bounded(observe(), captured.timeoutMs)
    if (!current()) { throw new Error('invalid') }
  } catch { reason = combined.aborted ? 'codex.mcp.cancelled' : 'codex.mcp.unavailable' }
  finally {
    stop.abort()
    if (dispose) { try { if (!await bounded(dispose(), Math.min(captured.timeoutMs, 5000))) { reason = 'codex.mcp.cleanup-unconfirmed' } } catch { reason = 'codex.mcp.cleanup-unconfirmed' } }
  }
  if ((reason !== undefined && reason.length > 0) || !result) { throw new Error(reason ?? 'codex.mcp.unavailable') }
  return result
}
