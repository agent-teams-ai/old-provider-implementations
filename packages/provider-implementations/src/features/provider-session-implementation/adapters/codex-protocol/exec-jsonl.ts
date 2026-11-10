import type { CodexNativeNormalizedEvent } from '../../contracts/codex-events.ts'

type CodexMcpToolCallItem = {
  id?: string
  type?: string
  text?: string
  server?: string
  tool?: string
  arguments?: unknown
  result?: unknown
  error?: unknown
  status?: string
  command?: string
  aggregated_output?: string
  output?: string
  stderr?: string
  exit_code?: number | null
  exitCode?: number | null
  changes?: Array<{
    path?: string
    kind?: string
  }>
}

type CodexExecJsonEvent = {
  type?: string
  thread_id?: string
  item?: CodexMcpToolCallItem
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
  message?: string
  [key: string]: unknown
}

function validJsonItem(value: unknown): boolean {
  const item = asRecord(value)
  if (!item) {return false}
  for (const field of ['id', 'type', 'text', 'server', 'tool', 'status', 'command', 'aggregated_output', 'output', 'stderr']) {
    if (item[field] !== undefined && typeof item[field] !== 'string') {return false}
  }
  for (const field of ['exit_code', 'exitCode']) {
    if (item[field] !== undefined && item[field] !== null && (typeof item[field] !== 'number' || !Number.isFinite(item[field]))) {return false}
  }
  if (item.changes !== undefined && (!Array.isArray(item.changes) || item.changes.some((entry: unknown) => {
    const change = asRecord(entry)
    return !change || ['path', 'kind'].some(key => change[key] !== undefined && typeof change[key] !== 'string')
  }))) {return false}
  return true
}
function isJsonEvent(value: unknown): value is CodexExecJsonEvent {
  const event = asRecord(value)
  if (!event || (event.type !== undefined && typeof event.type !== 'string')) {return false}
  for (const field of ['thread_id', 'message']) {
    if (event[field] !== undefined && typeof event[field] !== 'string') {return false}
  }
  if (event.usage !== undefined) {
    const usage = asRecord(event.usage)
    if (!usage || ['input_tokens', 'cached_input_tokens', 'output_tokens'].some(key => {
      const count = usage[key]
      return count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
    })) {return false}
  }
  if (event.error !== undefined) {
    const error = asRecord(event.error)
    if (!error || (error.message !== undefined && typeof error.message !== 'string')) {return false}
  }
  return event.item === undefined || validJsonItem(event.item)
}

function parseJsonLine(rawLine: string): CodexExecJsonEvent | null {
  try {
    const parsed = asRecord(JSON.parse(rawLine))
    if (!parsed) {return null}
    const params = asRecord(parsed.params)
    const event = typeof parsed.type !== 'string' && typeof parsed.method === 'string' && params !== null
      ? { ...params, type: parsed.method }
      : parsed
    return isJsonEvent(event) ? event : null
  } catch {
    return null
  }
}

export type CodexExecMappingOptions = { readonly nativeTools?: boolean }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function extractMcpToolResultText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  const record = asRecord(value)
  const content = record?.content
  if (Array.isArray(content)) {
    const textSegments = content
      .map(block => asRecord(block))
      .map(block => (block?.type === 'text' && typeof block.text === 'string' ? block.text : null))
      .filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
    if (textSegments.length > 0) {
      return textSegments.join('\n').trim()
    }
  }

  if (record) {
    const structuredContent = record.structured_content
    if (structuredContent !== undefined && structuredContent !== null) {
      return JSON.stringify(structuredContent)
    }
  }

  return null
}

function extractMcpToolErrorMessage(value: unknown): string | null {
  const record = asRecord(value)
  const message = record?.message
  return typeof message === 'string' && message.trim().length > 0 ? message : null
}

function normalizeItemStatus(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback
}

function summarizeFileChanges(changes: CodexMcpToolCallItem['changes']): string {
  const normalizedChanges = Array.isArray(changes) ? changes : []
  if (normalizedChanges.length === 0) {
    return 'File changes completed.'
  }
  return [
    'File changes:',
    ...normalizedChanges.map(change => {
      const path = typeof change.path === 'string' && change.path.trim().length > 0
        ? change.path.trim()
        : '(unknown path)'
      const kind = typeof change.kind === 'string' && change.kind.trim().length > 0
        ? change.kind.trim()
        : 'update'
      return `- ${path} (${kind})`
    }),
  ].join('\n')
}

function buildCommandResult(item: CodexMcpToolCallItem): Record<string, unknown> {
  const output =
    typeof item.aggregated_output === 'string'
      ? item.aggregated_output
      : typeof item.output === 'string'
        ? item.output
        : ''
  const stderr = typeof item.stderr === 'string' ? item.stderr : ''
  const exitCode =
    typeof item.exit_code === 'number'
      ? item.exit_code
      : typeof item.exitCode === 'number'
        ? item.exitCode
        : null
  const status = normalizeItemStatus(item.status, 'unknown')
  return {
    content: output || stderr || `Command ${status}.`,
    stdout: output,
    stderr,
    exitCode,
    status,
    toolName: 'Bash',
    toolUseId: item.id,
  }
}

function getCommandExitCode(item: CodexMcpToolCallItem): number | null {
  return typeof item.exit_code === 'number'
    ? item.exit_code
    : typeof item.exitCode === 'number'
      ? item.exitCode
      : null
}

function buildFileChangeResult(item: CodexMcpToolCallItem): Record<string, unknown> {
  const content = summarizeFileChanges(item.changes)
  return {
    content,
    changes: Array.isArray(item.changes) ? item.changes : [],
    status: normalizeItemStatus(item.status, 'unknown'),
    toolName: 'Edit',
    toolUseId: item.id,
  }
}

function mapNativeItemStarted(item: CodexMcpToolCallItem): CodexNativeNormalizedEvent[] {
  if (typeof item.id !== 'string') {
    return []
  }

  if (item.type === 'command_execution') {
    return [
      {
        type: 'tool_call_started',
        itemId: item.id,
        toolSource: 'native',
        toolName: 'Bash',
        arguments: {
          command: typeof item.command === 'string' ? item.command : '',
        },
        status: normalizeItemStatus(item.status, 'in_progress'),
        rawItemType: 'command_execution',
      },
    ]
  }

  if (item.type === 'file_change') {
    return [
      {
        type: 'tool_call_started',
        itemId: item.id,
        toolSource: 'native',
        toolName: 'Edit',
        arguments: {
          file_path: item.changes?.find(change => typeof change.path === 'string')?.path ?? '',
          changes: Array.isArray(item.changes) ? item.changes : [],
        },
        status: normalizeItemStatus(item.status, 'in_progress'),
        rawItemType: 'file_change',
      },
    ]
  }

  return []
}

function mapNativeItemCompleted(item: CodexMcpToolCallItem): CodexNativeNormalizedEvent[] {
  if (typeof item.id !== 'string') {
    return []
  }

  if (item.type === 'command_execution') {
    const status = normalizeItemStatus(item.status, 'unknown')
    const rawResult = buildCommandResult(item)
    const resultText = typeof rawResult.content === 'string' ? rawResult.content : null
    const exitCode = getCommandExitCode(item)
    return [
      {
        type: 'tool_call_completed',
        itemId: item.id,
        toolSource: 'native',
        toolName: 'Bash',
        arguments: {
          command: typeof item.command === 'string' ? item.command : '',
        },
        status,
        resultText,
        rawResult,
        errorMessage: status === 'failed' ? resultText : null,
        isError: status === 'failed' || status === 'declined' || (exitCode !== null && exitCode !== 0),
        rawItemType: 'command_execution',
      },
    ]
  }

  if (item.type === 'file_change') {
    const status = normalizeItemStatus(item.status, 'unknown')
    const rawResult = buildFileChangeResult(item)
    const resultText = typeof rawResult.content === 'string' ? rawResult.content : null
    return [
      {
        type: 'tool_call_completed',
        itemId: item.id,
        toolSource: 'native',
        toolName: 'Edit',
        arguments: {
          file_path: item.changes?.find(change => typeof change.path === 'string')?.path ?? '',
          changes: Array.isArray(item.changes) ? item.changes : [],
        },
        status,
        resultText,
        rawResult,
        errorMessage: status === 'failed' ? resultText : null,
        isError: status === 'failed',
        rawItemType: 'file_change',
      },
    ]
  }

  return []
}

function startedItemEvents(event: CodexExecJsonEvent, nativeTools: boolean): CodexNativeNormalizedEvent[] | null {
  if (
    event.item?.type === 'mcp_tool_call' &&
    typeof event.item.id === 'string' &&
    typeof event.item.server === 'string' &&
    typeof event.item.tool === 'string'
  ) {
    return [
      {
        type: 'tool_call_started',
        itemId: event.item.id,
        toolSource: 'mcp',
        serverName: event.item.server,
        toolName: event.item.tool,
        arguments: asRecord(event.item.arguments) ?? {},
        status:
          typeof event.item.status === 'string' && event.item.status.trim().length > 0
            ? event.item.status
            : 'in_progress',
        rawItemType: 'mcp_tool_call',
      },
    ]
  }

  if (event.item && nativeTools) {
    const nativeEvents = mapNativeItemStarted(event.item)
    if (nativeEvents.length > 0) {
      return nativeEvents
    }
    if (
      event.item.type === 'todo_list' ||
      event.item.type === 'reasoning' ||
      event.item.type === 'agent_message'
    ) {
      return []
    }
  }
  return null
}
function completedMcpItem(item: CodexMcpToolCallItem, itemId: string, serverName: string, toolName: string): CodexNativeNormalizedEvent[] {
  const errorMessage = extractMcpToolErrorMessage(item.error)
  const status = typeof item.status === 'string' && item.status.trim().length > 0 ? item.status : 'unknown'
  return [{ type: 'tool_call_completed', itemId, toolSource: 'mcp', serverName, toolName,
    arguments: asRecord(item.arguments) ?? {}, status, resultText: extractMcpToolResultText(item.result) ?? errorMessage,
    rawResult: item.result ?? item.error ?? null, errorMessage, isError: status === 'failed' || errorMessage !== null,
    rawItemType: 'mcp_tool_call' }]
}
function completedItemEvents(event: CodexExecJsonEvent, nativeTools: boolean): CodexNativeNormalizedEvent[] | null {
  if (
    event.item?.type === 'agent_message' &&
    typeof event.item.id === 'string' &&
    typeof event.item.text === 'string'
  ) {
    return [
      {
        type: 'assistant_text',
        itemId: event.item.id,
        text: event.item.text,
      },
    ]
  }

  if (
    event.item?.type === 'mcp_tool_call' &&
    typeof event.item.id === 'string' &&
    typeof event.item.server === 'string' &&
    typeof event.item.tool === 'string'
  ) {
    return completedMcpItem(event.item, event.item.id, event.item.server, event.item.tool)
  }

  if (event.item && nativeTools) {
    const nativeEvents = mapNativeItemCompleted(event.item)
    if (nativeEvents.length > 0) {
      return nativeEvents
    }
    if (event.item.type === 'todo_list' || event.item.type === 'reasoning') {
      return []
    }
  }

  return null
}
function mapItemEvent(event: CodexExecJsonEvent, nativeTools: boolean): CodexNativeNormalizedEvent[] | null {
  if (event.type === 'item.started') {return startedItemEvents(event, nativeTools)}
  if (event.type === 'item.completed') {return completedItemEvents(event, nativeTools)}
  return null
}

function completedTurnEvents(event: CodexExecJsonEvent): CodexNativeNormalizedEvent[] {
  const events: CodexNativeNormalizedEvent[] = []
  const usage = event.usage
  if (usage?.input_tokens !== undefined || usage?.cached_input_tokens !== undefined || usage?.output_tokens !== undefined) {
    events.push({
      type: 'usage_updated',
      ...(usage.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
      ...(usage.cached_input_tokens !== undefined ? { cachedInputTokens: usage.cached_input_tokens } : {}),
      ...(usage.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
    })
  }
  events.push({ type: 'turn_completed' })
  return events
}
function failedTurnEvents(event: CodexExecJsonEvent): CodexNativeNormalizedEvent[] {
  const message = event.error?.message?.trim()
  return [
    ...(message !== undefined && message.length > 0 ? [{
      type: 'warning' as const,
      source: 'codex' as const,
      text: `Codex native turn failed: ${message}`,
    }] : []),
    { type: 'turn_failed', ...(message !== undefined && message.length > 0 ? { errorMessage: message } : {}) },
  ]
}
function unhandledItemEvents(event: CodexExecJsonEvent, eventType: string, nativeTools: boolean): CodexNativeNormalizedEvent[] {
  const itemType = asRecord(event)?.item
  const itemRecord = asRecord(itemType)
  if (itemRecord?.type === 'todo_list' || itemRecord?.type === 'reasoning') {
    return []
  }
  if (
    !nativeTools &&
    (itemRecord?.type === 'command_execution' || itemRecord?.type === 'file_change')
  ) {
    return []
  }
  return [
    {
      type: 'unsupported_raw_event',
      rawType:
        typeof itemRecord?.type === 'string'
          ? `${eventType}:${itemRecord.type}`
          : eventType,
      payload: event,
    },
  ]
}
function mapJsonEvent(event: CodexExecJsonEvent, nativeTools: boolean): CodexNativeNormalizedEvent[] {
  if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
    return [{ type: 'thread_started', threadId: event.thread_id }]
  }
  if (event.type === 'turn.started') {return [{ type: 'turn_started' }]}
  const itemEvents = mapItemEvent(event, nativeTools)
  if (itemEvents !== null) {return itemEvents}
  if (event.type === 'turn.completed') {return completedTurnEvents(event)}
  if (event.type === 'error' && typeof event.message === 'string') {
    const message = event.message.trim()
    if (message.length > 0) {return [{ type: 'warning', source: 'codex', text: `Codex native error: ${message}` }]}
  }
  if (event.type === 'turn.failed') {return failedTurnEvents(event)}
  if (event.type === 'item.started' || event.type === 'item.completed' || event.type === 'item.updated') {
    return unhandledItemEvents(event, event.type, nativeTools)
  }
  return [
    {
      type: 'unsupported_raw_event',
      rawType: event.type ?? 'unknown',
      payload: event,
    },
  ]
}

export function mapCodexNativeExecLine(
  rawLine: string,
  options: CodexExecMappingOptions = {},
): CodexNativeNormalizedEvent[] {
  const line = rawLine.trim()
  if (!line) {
    return []
  }

  if (!line.startsWith('{')) {
    return [
      {
        type: 'warning',
        source: 'stderr',
        text: line,
      },
    ]
  }

  const parsed = parseJsonLine(line)
  if (!parsed) {
    return [
      {
        type: 'warning',
        source: 'stderr',
        text: line,
      },
    ]
  }

  return mapJsonEvent(parsed, options.nativeTools ?? true)
}

export function mapCodexNativeExecOutput(
  rawOutput: string,
  options: CodexExecMappingOptions = {},
): CodexNativeNormalizedEvent[] {
  return rawOutput
    .split(/\r?\n/)
    .flatMap(line => mapCodexNativeExecLine(line, options))
}
