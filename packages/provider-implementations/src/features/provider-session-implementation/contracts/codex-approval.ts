export type CodexAppServerApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'item/tool/requestUserInput'
  | 'mcpServer/elicitation/request'
  | 'execCommandApproval'
  | 'applyPatchApproval'

export type CodexAppServerRequestId = string | number

export interface CodexAppServerRequest<TParams = Record<string, unknown>> {
  jsonrpc?: '2.0'
  id: CodexAppServerRequestId
  method: string
  params?: TParams
}

export interface CodexAppServerToolApprovalRequest {
  providerId: 'codex'
  requestId: string
  providerRequestId: string
  method: CodexAppServerApprovalMethod
  threadId: string | null
  turnId: string | null
  itemId: string | null
  toolName: string
  toolInput: Record<string, unknown>
  reason: string | null
  raw: Record<string, unknown>
}

export interface CodexAppServerApprovalDecision {
  allow: boolean
  message?: string
}
