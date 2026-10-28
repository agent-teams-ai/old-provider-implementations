import type { CodexAppServerRequest, CodexAppServerRequestId, CodexAppServerApprovalMethod, CodexAppServerToolApprovalRequest } from '../../contracts/codex-approval.ts'

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function requestIdToString(id: CodexAppServerRequestId): string {
  return typeof id === 'number' ? String(id) : id
}
function legacyCommand(value: unknown): string | null {
  return Array.isArray(value) ? value.filter((part): part is string => typeof part === 'string').join(' ') : null
}
// Preserve the legacy optional opaque extension without interpreting it as a grant.
function additionalPermissions(params: Record<string, unknown>): Record<string, unknown> {
  const value = params.additionalPermissions
  if (value === undefined || value === null || value === false || value === '' || value === 0 || value === 0n
    || (typeof value === 'number' && Number.isNaN(value))) {return {}}
  return { additionalPermissions: value }
}

function buildProviderRequestId(
  request: Pick<CodexAppServerRequest, 'id' | 'method'>,
  params: Record<string, unknown>,
): string {
  const scopedId =
    stringValue(params.approvalId) ??
    stringValue(params.callId) ??
    stringValue(params.itemId) ??
    requestIdToString(request.id)
  return `codex:${request.method}:${scopedId}`
}

export function isCodexAppServerApprovalMethod(
  method: string,
): method is CodexAppServerApprovalMethod {
  return (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/permissions/requestApproval' ||
    method === 'item/tool/requestUserInput' ||
    method === 'mcpServer/elicitation/request' ||
    method === 'execCommandApproval' ||
    method === 'applyPatchApproval'
  )
}

function toolApprovalMethod(method: string): method is Exclude<CodexAppServerApprovalMethod, 'item/tool/requestUserInput' | 'mcpServer/elicitation/request'> {
  return isCodexAppServerApprovalMethod(method) && method !== 'item/tool/requestUserInput' && method !== 'mcpServer/elicitation/request'
}

function normalizeToolApprovalRequest(
  request: CodexAppServerRequest,
): CodexAppServerToolApprovalRequest | null {
  if (!toolApprovalMethod(request.method)) {
    return null
  }

  const params = asRecord(request.params)
  const requestId = requestIdToString(request.id)
  const providerRequestId = buildProviderRequestId(request, params)

  switch (request.method) {
    case 'item/commandExecution/requestApproval': {
      const command = stringValue(params.command)
      return {
        providerId: 'codex',
        requestId,
        providerRequestId,
        method: request.method,
        threadId: stringValue(params.threadId),
        turnId: stringValue(params.turnId),
        itemId: stringValue(params.itemId),
        toolName: 'Bash',
        toolInput: {
          provider: 'codex',
          providerRequestId,
          ...(command !== null ? { command } : {}),
          ...(stringValue(params.cwd) !== null ? { cwd: stringValue(params.cwd) } : {}),
          ...(Array.isArray(params.commandActions)
            ? { commandActions: params.commandActions }
            : {}),
          ...additionalPermissions(params),
        },
        reason: stringValue(params.reason),
        raw: params,
      }
    }
    case 'execCommandApproval': {
      const command = legacyCommand(params.command)
      return {
        providerId: 'codex',
        requestId,
        providerRequestId,
        method: request.method,
        threadId: stringValue(params.conversationId),
        turnId: null,
        itemId: stringValue(params.callId),
        toolName: 'Bash',
        toolInput: {
          provider: 'codex',
          providerRequestId,
          ...(command !== null && command.length > 0 ? { command } : {}),
          ...(stringValue(params.cwd) !== null ? { cwd: stringValue(params.cwd) } : {}),
          ...(Array.isArray(params.parsedCmd) ? { parsedCommand: params.parsedCmd } : {}),
        },
        reason: stringValue(params.reason),
        raw: params,
      }
    }
    case 'item/fileChange/requestApproval': {
      return {
        providerId: 'codex',
        requestId,
        providerRequestId,
        method: request.method,
        threadId: stringValue(params.threadId),
        turnId: stringValue(params.turnId),
        itemId: stringValue(params.itemId),
        toolName: 'Edit',
        toolInput: {
          provider: 'codex',
          providerRequestId,
          ...(stringValue(params.grantRoot) !== null ? { file_path: stringValue(params.grantRoot) } : {}),
          ...(stringValue(params.grantRoot) !== null ? { grantRoot: stringValue(params.grantRoot) } : {}),
        },
        reason: stringValue(params.reason),
        raw: params,
      }
    }
    case 'applyPatchApproval': {
      const fileChanges = asRecord(params.fileChanges)
      const filePaths = Object.keys(fileChanges)
      return {
        providerId: 'codex',
        requestId,
        providerRequestId,
        method: request.method,
        threadId: stringValue(params.conversationId),
        turnId: null,
        itemId: stringValue(params.callId),
        toolName: 'Edit',
        toolInput: {
          provider: 'codex',
          providerRequestId,
          fileChanges,
          filePaths,
          ...(stringValue(params.grantRoot) !== null ? { grantRoot: stringValue(params.grantRoot) } : {}),
          ...(filePaths[0] !== undefined && filePaths[0].length > 0 ? { file_path: filePaths[0] } : {}),
        },
        reason: stringValue(params.reason),
        raw: params,
      }
    }
    case 'item/permissions/requestApproval': {
      return {
        providerId: 'codex',
        requestId,
        providerRequestId,
        method: request.method,
        threadId: stringValue(params.threadId),
        turnId: stringValue(params.turnId),
        itemId: stringValue(params.itemId),
        toolName: 'CodexPermissions',
        toolInput: {
          provider: 'codex',
          providerRequestId,
          permissions: params.permissions,
          ...(stringValue(params.cwd) !== null ? { cwd: stringValue(params.cwd) } : {}),
        },
        reason: stringValue(params.reason),
        raw: params,
      }
    }
  }
}

export function normalizeCodexAppServerApprovalRequest(request: CodexAppServerRequest): CodexAppServerToolApprovalRequest | null {
  if (request.method !== 'item/tool/requestUserInput' && request.method !== 'mcpServer/elicitation/request') { return normalizeToolApprovalRequest(request) }
  const params = asRecord(request.params)
  return { providerId: 'codex', requestId: requestIdToString(request.id), providerRequestId: buildProviderRequestId(request, params), method: request.method,
    threadId: stringValue(params.threadId), turnId: stringValue(params.turnId), itemId: stringValue(params.itemId),
    toolName: 'AskUserQuestion', toolInput: {}, reason: null, raw: params }
}
