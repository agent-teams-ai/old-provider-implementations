/** Native managed boundaries, taken from the selected pinned CLIs; not a known-flag catalog. */
const legacy = ['input-format', 'output-format', 'setting-sources', 'mcp-config', 'disallowedtools', 'verbose', 'model', 'effort', 'teammate-mode', 'resume', 'settings', 'permission-mode', 'permission-prompt-tool', 'dangerously-skip-permissions']
const claude = new Set([...legacy, 'allowedtools', 'allowed-tools', 'disallowed-tools', 'tools', 'strict-mcp-config', 'agent', 'agents', 'session-id', 'continue', 'fork-session', 'from-pr', 'teleport', 'name', 'worktree', 'tmux', 'add-dir', 'file', 'plugin-dir', 'plugin-url', 'bare', 'safe-mode', 'restricted', 'managed-settings', 'allow-dangerously-skip-permissions', 'permission-prompts', 'fallback-model', 'system-prompt', 'system-prompt-file', 'append-system-prompt', 'append-system-prompt-file', 'debug-file', 'chrome', 'no-chrome', 'ide', 'print', 'bg', 'background', 'desktop', 'cloud', 'environment', 'remote-control', 'remote-control-session-name-prefix', 'include-partial-messages', 'include-hook-events', 'replay-user-messages', 'no-session-persistence', 'help', 'version'])
const codex = new Set([...legacy, 'config', 'enable', 'disable', 'profile', 'cd', 'add-dir', 'worktree', 'oss', 'local-provider', 'image', 'sandbox', 'ask-for-approval', 'approve-for-me', 'dangerously-bypass-approvals-and-sandbox', 'dangerously-bypass-hook-trust', 'code-mode-host', 'remote', 'remote-auth-token-env', 'listen', 'stdio', 'ws-auth', 'ws-token-file', 'ws-token-sha256', 'ws-shared-secret-file', 'ws-issuer', 'ws-audience', 'ws-max-clock-skew-seconds', 'help', 'version'])
const opencode = new Set([...legacy, 'hostname', 'port', 'mdns', 'mdns-domain', 'cors', 'continue', 'session', 'fork', 'prompt', 'agent', 'auto', 'pure', 'mini', 'no-replay', 'replay-limit', 'help', 'version'])

type Arity = 'none' | 'one' | 'optional' | 'many' | 'boolean'
// Only safe native forms needed by the selected CLIs, plus public SDK cost limits.
// Native managed flags above remain refused independently of this value grammar.
const claudeValues: ReadonlyMap<string, Arity> = new Map([
  ['max-turns', 'one'], ['max-budget-usd', 'one'], ['debug', 'optional'], ['autocompact', 'one'],
  ['betas', 'many'], ['disable-slash-commands', 'none'], ['ax-screen-reader', 'none'],
  ['exclude-dynamic-system-prompt-sections', 'none'], ['json-schema', 'one'],
  ['prompt-suggestions', 'optional'], ['system-prompt-snapshot', 'one'],
])
const codexValues: ReadonlyMap<string, Arity> = new Map([['strict-config', 'none'], ['analytics-default-enabled', 'none']])
const opencodeValues: ReadonlyMap<string, Arity> = new Map([['print-logs', 'boolean'], ['log-level', 'one']])

function snapshot(args: readonly string[] | undefined): readonly string[] {
  if (args === undefined) {return Object.freeze([])}
  if (!Array.isArray(args)) {throw new Error('provider.cli.invalid-args')}
  const count = args.length
  if (!Number.isSafeInteger(count) || count < 0 || count > 1024) {throw new Error('provider.cli.invalid-args')}
  const result: string[] = []
  let bytes = 0
  for (let index = 0; index < count; index++) {
    const value: unknown = args[index]
    if (typeof value !== 'string' || value.length > 64 * 1024 || /[\0\r\n]/u.test(value)) {throw new Error('provider.cli.invalid-args')}
    bytes += Buffer.byteLength(value) + 1
    if (bytes > 64 * 1024) {throw new Error('provider.cli.invalid-args')}
    result.push(value)
  }
  return Object.freeze(result)
}
function flag(token: string, debugShort: boolean): { name: string; inline?: string } {
  if (debugShort && token.startsWith('-d') && !token.startsWith('--')) {
    const tail = token.slice(2)
    return { name: 'debug', ...(tail ? { inline: tail.startsWith('=') ? tail.slice(1) : tail } : {}) }
  }
  if (!token.startsWith('--') || token === '--') {throw new Error('provider.cli.invalid-args')}
  const equal = token.indexOf('=')
  return { name: (equal === -1 ? token.slice(2) : token.slice(2, equal)).toLowerCase(),
    ...(equal === -1 ? {} : { inline: token.slice(equal + 1) }) }
}
function nextIndex(args: readonly string[], index: number, selected: { inline?: string }, arity: Arity): number {
  if (selected.inline !== undefined) {
    if (arity === 'none' || (arity === 'boolean' && !['true', 'false'].includes(selected.inline))) {throw new Error('provider.cli.invalid-args')}
    if (arity !== 'many') {return index + 1}
  }
  if (arity === 'none' || arity === 'boolean') {return index + 1}
  let next = index + 1
  const end = arity === 'many' ? args.length : Math.min(args.length, index + 2)
  while (next < end && !args[next]!.startsWith('-')) {next++}
  if (arity !== 'optional' && next === index + 1 && selected.inline === undefined) {throw new Error('provider.cli.invalid-args')}
  return next
}
function capture(args: readonly string[] | undefined, blocked: ReadonlySet<string>, shapes: ReadonlyMap<string, Arity>, debugShort = false): readonly string[] {
  const captured = snapshot(args)
  for (let index = 0; index < captured.length;) {
    const selected = flag(captured[index]!, debugShort)
    if (blocked.has(selected.name) || (selected.name.startsWith('no-') && blocked.has(selected.name.slice(3)))) {throw new Error('provider.cli.managed-argument')}
    const arity = shapes.get(selected.name)
    if (arity === undefined) {throw new Error('provider.cli.unsupported-argument')}
    index = nextIndex(captured, index, selected, arity)
  }
  return captured
}
export const captureClaudeExtraArgs = (args?: readonly string[]): readonly string[] => capture(args, claude, claudeValues, true)
export const captureCodexExtraArgs = (args?: readonly string[]): readonly string[] => capture(args, codex, codexValues)
export const captureOpenCodeExtraArgs = (args?: readonly string[]): readonly string[] => capture(args, opencode, opencodeValues)
