import type { OpenCodeClient } from './client-types.ts'
import type { OpenCodeRequest } from './http-request.ts'
import type { OpenCodeAgentResponse, OpenCodeConfigProvidersResponse, OpenCodeConfigResponse, OpenCodeMcpResponse, OpenCodeProviderAuthMethod, OpenCodeProviderOAuthAuthorization, OpenCodeProviderResponse, OpenCodeServerDocResponse } from './types.ts'
import { DEFAULT_REQUEST_TIMEOUT_MS, OPEN_CODE_INSTANCE_INITIALIZATION_TIMEOUT_MS, MCP_REQUEST_TIMEOUT_MS, PROVIDER_OAUTH_AUTHORIZE_TIMEOUT_MS, PROVIDER_OAUTH_CALLBACK_TIMEOUT_MS } from './request-limits.ts'

export function createCatalogOperations(request: OpenCodeRequest): Pick<OpenCodeClient, 'getConfig' | 'getConfigProviders' | 'getProviders' | 'getProviderAuth' | 'getServerDoc' | 'authorizeProviderOAuth' | 'completeProviderOAuth' | 'setProviderAuth' | 'deleteProviderAuth' | 'listAgents' | 'getMcp' | 'addMcp' | 'connectMcp'> {
  return {
      getConfig: () => request<OpenCodeConfigResponse>('/config'),
      getConfigProviders: options => request<OpenCodeConfigProvidersResponse>(
        '/config/providers',
        undefined,
        options?.initializeInstance === true
          ? OPEN_CODE_INSTANCE_INITIALIZATION_TIMEOUT_MS
          : DEFAULT_REQUEST_TIMEOUT_MS,
      ),
      getProviders: () => request<OpenCodeProviderResponse>('/provider'),
      getProviderAuth: () =>
        request<Record<string, OpenCodeProviderAuthMethod[]>>('/provider/auth'),
      getServerDoc: () => request<OpenCodeServerDocResponse>('/doc'),
      authorizeProviderOAuth: (providerId, body) =>
        request<OpenCodeProviderOAuthAuthorization>(
          `/provider/${encodeURIComponent(providerId)}/oauth/authorize`,
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
          PROVIDER_OAUTH_AUTHORIZE_TIMEOUT_MS,
        ),
      completeProviderOAuth: (providerId, body) =>
        request<boolean>(
          `/provider/${encodeURIComponent(providerId)}/oauth/callback`,
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
          PROVIDER_OAUTH_CALLBACK_TIMEOUT_MS,
        ),
      setProviderAuth: (providerId, body) =>
        request<boolean>(`/auth/${encodeURIComponent(providerId)}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        }),
      deleteProviderAuth: providerId =>
        request<boolean>(`/auth/${encodeURIComponent(providerId)}`, {
          method: 'DELETE',
        }),
      listAgents: () => request<OpenCodeAgentResponse[]>('/agent'),
      getMcp: () => request<OpenCodeMcpResponse>('/mcp', undefined, MCP_REQUEST_TIMEOUT_MS),
      addMcp: (name, config) =>
        request<OpenCodeMcpResponse>(
          '/mcp',
          {
            method: 'POST',
            body: JSON.stringify({
              name,
              config,
            }),
          },
          MCP_REQUEST_TIMEOUT_MS,
        ),
      connectMcp: name =>
        request<OpenCodeMcpResponse>(
          `/mcp/${encodeURIComponent(name)}/connect`,
          {
            method: 'POST',
          },
          MCP_REQUEST_TIMEOUT_MS,
        ),

  }
}
