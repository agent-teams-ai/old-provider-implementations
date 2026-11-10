import type { OpenCodeClient } from './client-types.ts'
import type { OpenCodeClientRequestContext } from './OpenCodeClientRequestContext.ts'
import { createOpenCodeRequest } from './http-request.ts'
import { createCatalogOperations } from './catalog-operations.ts'
import { createSessionOperations } from './session-operations.ts'
export type { OpenCodeClient } from './client-types.ts'
export type { OpenCodeClientRequestContext } from './OpenCodeClientRequestContext.ts'
export { OPEN_CODE_INSTANCE_INITIALIZATION_TIMEOUT_MS } from './request-limits.ts'

type OpenCodeClientFactoryDeps = {
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

export class OpenCodeClientFactory {
  private readonly deps: OpenCodeClientFactoryDeps
  constructor(deps: OpenCodeClientFactoryDeps = {}) { this.deps = deps }

  create(baseUrl: string, context: OpenCodeClientRequestContext = {}): OpenCodeClient {
    const endpoint = new URL(baseUrl)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error('OpenCode requires an explicit HTTP endpoint without embedded credentials')
    }
    const boundContext = { ...context, boundedReconciliation: true }
    const request = createOpenCodeRequest(endpoint.href.replace(/\/$/, ''), boundContext, this.deps.fetchImpl ?? fetch)
    return { ...createCatalogOperations(request), ...createSessionOperations(request, boundContext) }
  }
}
