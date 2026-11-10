export type OpenCodeConfigResponse = {
  agent?: Record<string, unknown>
  mode?: Record<string, unknown>
  plugin?: unknown[]
  command?: Record<string, unknown>
  username?: string
  default_agent?: string
  share?: string
  autoupdate?: boolean | 'notify'
  snapshot?: boolean
  permission?: Record<string, unknown>
}

export type OpenCodeProviderAuthPromptOption = {
  label?: string
  value?: string
  hint?: string
}

export type OpenCodeProviderAuthPromptCondition = {
  key?: string
  op?: string
  value?: string
}

export type OpenCodeProviderAuthPrompt = {
  type?: string
  key?: string
  message?: string
  placeholder?: string
  options?: OpenCodeProviderAuthPromptOption[]
  when?: OpenCodeProviderAuthPromptCondition
}

export type OpenCodeProviderAuthMethod = {
  type?: string
  label?: string
  prompts?: OpenCodeProviderAuthPrompt[]
}

export type OpenCodeApiAuthInput = {
  type: 'api'
  key: string
  metadata?: Record<string, string>
}

export type OpenCodeProviderOAuthAuthorizeInput = {
  method: number
  inputs?: Record<string, string>
}

export type OpenCodeProviderOAuthAuthorization = {
  url: string
  method: 'auto' | 'code'
  instructions: string
}

export type OpenCodeProviderOAuthCallbackInput = {
  method: number
  code?: string
}

export type OpenCodeServerDocResponse = {
  paths?: Record<string, Record<string, unknown>>
}

export type OpenCodeMcpServerConfig = {
  type: 'local' | 'remote'
  command?: string[]
  environment?: Record<string, string>
  enabled?: boolean
  timeout?: number
  url?: string
  headers?: Record<string, string>
  oauth?: boolean | Record<string, unknown>
}

export type OpenCodeProviderListEntry = {
  id?: string
  source?: string
  name?: string
  npm?: string
  options?: Record<string, unknown>
  models?: Record<string, unknown>
}

export type OpenCodeConfigProvidersResponse = {
  providers?: OpenCodeProviderListEntry[]
  default?: Record<string, string>
}

export type OpenCodeProviderResponse = {
  all?: OpenCodeProviderListEntry[]
  default?: Record<string, string>
  connected?: string[]
}

export type OpenCodeAgentResponse = {
  name?: string
  description?: string
  mode?: string
  native?: boolean
  hidden?: boolean
}

export type OpenCodeMcpStatusEntry = Record<string, unknown>

export type OpenCodeMcpResponse = Record<string, OpenCodeMcpStatusEntry>

export type OpenCodeSessionSummary = {
  id: string
  slug?: string
  title?: string
  projectID?: string
  directory?: string
  version?: string
}

export type OpenCodeSessionStatus = 'idle' | 'busy' | 'retry'

export type OpenCodeSessionStatusPayload = {
  type?: string
  status?: string
  message?: string
  attempt?: number
  next?: number
}

export type OpenCodeSessionStatusInput =
  | OpenCodeSessionStatusPayload
  | string

export type OpenCodePendingPermission = {
  id?: string
  requestID?: string
  requestId?: string
  permissionID?: string
  permissionId?: string
  sessionID?: string
  sessionId?: string
  session?: string
  // OpenCode 1.18 sends `tool` as the {messageID, callID} reference and the tool
  // name in the string `permission` field; older builds used a string `tool`.
  tool?: string | Record<string, unknown>
  toolName?: string
  name?: string
  title?: string
  description?: string
  kind?: string
  type?: string
  metadata?: Record<string, unknown>
  permission?: string | Record<string, unknown>
  [key: string]: unknown
}

export type OpenCodeSseEvent = {
  type: string
  properties: Record<string, unknown>
  directory: string | null
  raw: unknown
}

export type OpenCodeMessagePart = {
  type?: string
  id?: string
  text?: string
  sessionID?: string
  messageID?: string
  [key: string]: unknown
}

export type OpenCodeMessage = {
  info: Record<string, unknown>
  parts: OpenCodeMessagePart[]
}
