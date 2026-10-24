export type { OpenCodeClientRequestContext } from './OpenCodeClientRequestContext.ts'
import type {
  OpenCodeAgentResponse,
  OpenCodeApiAuthInput,
  OpenCodeConfigProvidersResponse,
  OpenCodeConfigResponse,
  OpenCodeMessage,
  OpenCodeMcpResponse,
  OpenCodeMcpServerConfig,
  OpenCodePendingPermission,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderOAuthAuthorization,
  OpenCodeProviderOAuthAuthorizeInput,
  OpenCodeProviderOAuthCallbackInput,
  OpenCodeProviderResponse,
  OpenCodeServerDocResponse,
  OpenCodeSessionStatusInput,
  OpenCodeSessionSummary,
} from './types.ts'

export type OpenCodeClient = {
  getConfig(): Promise<OpenCodeConfigResponse>
  getConfigProviders(options?: { initializeInstance?: boolean }): Promise<OpenCodeConfigProvidersResponse>
  getProviders(): Promise<OpenCodeProviderResponse>
  getProviderAuth(): Promise<Record<string, OpenCodeProviderAuthMethod[]>>
  getServerDoc(): Promise<OpenCodeServerDocResponse>
  authorizeProviderOAuth(
    providerId: string,
    body: OpenCodeProviderOAuthAuthorizeInput,
  ): Promise<OpenCodeProviderOAuthAuthorization>
  completeProviderOAuth(
    providerId: string,
    body: OpenCodeProviderOAuthCallbackInput,
  ): Promise<boolean>
  setProviderAuth(providerId: string, body: OpenCodeApiAuthInput): Promise<boolean>
  deleteProviderAuth(providerId: string): Promise<boolean>
  listAgents(): Promise<OpenCodeAgentResponse[]>
  getMcp(): Promise<OpenCodeMcpResponse>
  addMcp?(name: string, config: OpenCodeMcpServerConfig): Promise<OpenCodeMcpResponse>
  connectMcp?(name: string): Promise<OpenCodeMcpResponse>
  createSession(body?: { parentID?: string; title?: string }): Promise<OpenCodeSessionSummary>
  getSession(id: string): Promise<OpenCodeSessionSummary>
  getSessionStatus(): Promise<Record<string, OpenCodeSessionStatusInput>>
  getSessionMessages(id: string, limit?: number, before?: string): Promise<OpenCodeMessage[]>
  getSessionMessage?(id: string, messageID: string): Promise<OpenCodeMessage | null>
  getPermissions(): Promise<OpenCodePendingPermission[]>
  listExperimentalToolIds(input?: {
    directory?: string | null
    workspace?: string | null
  }): Promise<string[]>
  listExperimentalTools(input: {
    directory?: string | null
    workspace?: string | null
    provider: string
    model: string
  }): Promise<Array<{ id?: string; name?: string; parameters?: unknown }>>
  answerPermission(body: {
    requestId: string
    sessionId?: string | null
    decision: 'allow' | 'always' | 'reject'
    message?: string
  }): Promise<unknown>
  sendSessionMessage(
    id: string,
    body: {
      messageID?: string
      agent?: string
      noReply?: boolean
      system?: string
      tools?: Record<string, boolean>
      variant?: string
      model?: {
        providerID: string
        modelID: string
      }
      parts: Array<Record<string, unknown>>
    },
  ): Promise<OpenCodeMessage>
  promptSessionAsync(
    id: string,
    body: {
      messageID?: string
      agent?: string
      noReply?: boolean
      system?: string
      tools?: Record<string, boolean>
      variant?: string
      model?: {
        providerID: string
        modelID: string
      }
      parts: Array<Record<string, unknown>>
    },
  ): Promise<void>
  abortSession(id: string): Promise<boolean>
}
