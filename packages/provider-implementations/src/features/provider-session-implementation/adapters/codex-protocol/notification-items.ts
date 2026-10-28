import type { CodexNativeNormalizedEvent } from '../../contracts/codex-events.ts'
import { record, string } from './wire-frames.ts'
function commandArguments(item: Record<string, unknown>): Record<string, unknown> {
  return { command: string(item.command) ?? '', cwd: string(item.cwd) ?? undefined,
    commandActions: Array.isArray(item.commandActions) ? item.commandActions : undefined }
}

export function mapThreadItemToToolStarted(item: Record<string, unknown>): CodexNativeNormalizedEvent | null {
  const itemType = string(item.type)
  const itemId = string(item.id)
  if (itemType === null || itemId === null) {return null}

  if (itemType === 'commandExecution') {
    return {
      type: 'tool_call_started',
      itemId,
      toolSource: 'native',
      toolName: 'Bash',
      arguments: commandArguments(item),
      status: string(item.status) ?? 'unknown',
      rawItemType: itemType,
    }
  }

  if (itemType === 'fileChange') {
    return {
      type: 'tool_call_started',
      itemId,
      toolSource: 'native',
      toolName: 'Edit',
      arguments: {
        changes: Array.isArray(item.changes) ? item.changes : [],
      },
      status: string(item.status) ?? 'unknown',
      rawItemType: itemType,
    }
  }

  if (itemType === 'mcpToolCall') {
    const serverName = string(item.server)
    const toolName = string(item.tool)
    if (serverName === null || toolName === null) {return null}
    return {
      type: 'tool_call_started',
      itemId,
      toolSource: 'mcp',
      serverName,
      toolName,
      arguments: record(item.arguments) ?? {},
      status: string(item.status) ?? 'unknown',
      rawItemType: itemType,
    }
  }

  if (itemType === 'dynamicToolCall') {
    const namespace = string(item.namespace)
    const toolName = string(item.tool)
    if (toolName === null) {return null}
    return {
      type: 'tool_call_started',
      itemId,
      toolSource: 'native',
      toolName: namespace !== null ? `${namespace}.${toolName}` : toolName,
      arguments: record(item.arguments) ?? {},
      status: string(item.status) ?? 'unknown',
      rawItemType: itemType,
    }
  }

  return null
}

type Completion = Pick<Extract<CodexNativeNormalizedEvent, { type: 'tool_call_completed' }>, 'resultText' | 'rawResult' | 'errorMessage' | 'isError'>
function commandCompletion(item: Record<string, unknown>): Completion {
  const status = string(item.status), exitCode = typeof item.exitCode === 'number' ? item.exitCode : null
  const isError = status === 'failed' || status === 'declined' || (exitCode !== null && exitCode !== 0)
  return { rawResult: item, resultText: string(item.aggregatedOutput), isError, errorMessage: isError ? `Command ${status ?? 'failed'}` : null }
}
function mcpCompletion(item: Record<string, unknown>): Completion {
  const rawResult = item.result ?? item.error ?? item
  const resultText = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult)
  const isError = (item.error !== null && item.error !== undefined) || string(item.status) === 'failed'
  return { rawResult, resultText, isError, errorMessage: isError ? resultText : null }
}
function completion(item: Record<string, unknown>): Completion {
  const itemType = string(item.type)
  if (itemType === 'commandExecution') {return commandCompletion(item)}
  if (itemType === 'mcpToolCall') {return mcpCompletion(item)}
  if (itemType !== 'dynamicToolCall' && itemType !== 'fileChange') {return { rawResult: item, resultText: null, errorMessage: null, isError: false }}
  const rawResult = itemType === 'dynamicToolCall' ? item.contentItems ?? item : item.changes ?? item
  const resultText = JSON.stringify(rawResult)
  const isError = itemType === 'dynamicToolCall' ? item.success === false : string(item.status) === 'failed'
  return { rawResult, resultText, isError, errorMessage: isError ? resultText : null }
}
export function mapThreadItemToToolCompleted(item: Record<string, unknown>): CodexNativeNormalizedEvent | null {
  const started = mapThreadItemToToolStarted(item)
  if (!started || started.type !== 'tool_call_started') {return null}
  return {
    type: 'tool_call_completed',
    itemId: started.itemId,
    toolSource: started.toolSource,
    ...(started.serverName !== undefined && started.serverName.length > 0 ? { serverName: started.serverName } : {}),
    toolName: started.toolName,
    arguments: started.arguments,
    status: string(item.status) ?? 'unknown',
    ...completion(item),
    rawItemType: started.rawItemType,
  }
}
