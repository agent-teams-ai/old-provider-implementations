import type { OpenCodeClient } from './client-types.ts'
import type { OpenCodeRequest } from './http-request.ts'
import type { OpenCodeMessage, OpenCodePendingPermission, OpenCodeSessionStatusInput, OpenCodeSessionSummary } from './types.ts'
import { DEFAULT_REQUEST_TIMEOUT_MS, PERMISSION_REQUEST_TIMEOUT_MS, MESSAGE_REQUEST_TIMEOUT_MS } from './request-limits.ts'
import { buildQueryPath } from './query-path.ts'
import type { OpenCodeClientRequestContext } from './OpenCodeClientRequestContext.ts'

async function boundedMessageLookup(request: OpenCodeRequest, id: string, messageID: string, cause: unknown): Promise<OpenCodeMessage | null> {
  let before: string | undefined
  for (let page = 0; page < 4; page++) {
    const messages = await request<OpenCodeMessage[]>(buildQueryPath(`/session/${encodeURIComponent(id)}/message`, { limit: '50', before }), undefined, DEFAULT_REQUEST_TIMEOUT_MS, 50, 'transcript')
    const found = messages.find(message => message.info.id === messageID)
    if (found) { return found }
    if (messages.length < 50) { return null }
    const oldest = messages[0]?.info.id
    if (typeof oldest !== 'string' || oldest === before) { throw new Error('Invalid native pagination boundary', { cause }) }
    before = oldest
  }
  throw new Error('Native message lookup pagination budget exhausted; completeness unknown', { cause })
}
export function createSessionOperations(request: OpenCodeRequest, context: OpenCodeClientRequestContext): Pick<OpenCodeClient, 'createSession' | 'getSession' | 'getSessionStatus' | 'getSessionMessages' | 'getSessionMessage' | 'getPermissions' | 'listExperimentalToolIds' | 'listExperimentalTools' | 'answerPermission' | 'sendSessionMessage' | 'promptSessionAsync' | 'abortSession'> {
  return {
      createSession: body =>
        request<OpenCodeSessionSummary>('/session', {
          method: 'POST',
          body: JSON.stringify(body ?? {}),
        }),
      getSession: id => request<OpenCodeSessionSummary>(`/session/${encodeURIComponent(id)}`),
      getSessionStatus: () =>
        request<Record<string, OpenCodeSessionStatusInput>>('/session/status'),
      getSessionMessages: (id, limit, before) =>
        request<OpenCodeMessage[]>(
          buildQueryPath(`/session/${encodeURIComponent(id)}/message`, {
            limit: typeof limit === 'number' ? String(limit) : context.boundedReconciliation === true ? '50' : null,
            before,
          }), undefined, DEFAULT_REQUEST_TIMEOUT_MS,
          typeof limit === 'number' ? limit : context.boundedReconciliation === true ? 50 : undefined,
          'transcript',
        ),
      getSessionMessage: async (id, messageID) => {
        try {
          return await request<OpenCodeMessage>(
            `/session/${encodeURIComponent(id)}/message/${encodeURIComponent(messageID)}`,
            undefined, DEFAULT_REQUEST_TIMEOUT_MS, undefined, 'transcript',
          )
        } catch (error) {
          if (error instanceof Error && error.message.includes('(404 ')) {
            if (context.boundedReconciliation === true) {
              return boundedMessageLookup(request, id, messageID, error)
            }

          }
          throw error
        }
      },
      getPermissions: () =>
        request<OpenCodePendingPermission[]>(
          '/permission',
          undefined,
          PERMISSION_REQUEST_TIMEOUT_MS,
        ),
      listExperimentalToolIds: input =>
        request<string[]>(
          buildQueryPath('/experimental/tool/ids', {
            directory: input?.directory,
            workspace: input?.workspace,
          }),
        ),
      listExperimentalTools: input =>
        request<Array<{ id?: string; name?: string; parameters?: unknown }>>(
          buildQueryPath('/experimental/tool', {
            directory: input.directory,
            workspace: input.workspace,
            provider: input.provider,
            model: input.model,
          }),
        ),
      answerPermission: async body => {
        const reply = body.decision === 'allow' ? 'once' : body.decision
        const payload = {
          requestID: body.requestId,
          requestId: body.requestId,
          sessionID: body.sessionId ?? undefined,
          sessionId: body.sessionId ?? undefined,
          reply,
          response: body.decision,
          decision: body.decision,
          allow: body.decision === 'allow' || body.decision === 'always',
          always: body.decision === 'always',
          // With a message, OpenCode turns a reject into feedback for the model instead of
          // blocking the session, so the turn continues and can still answer in text.
          ...(body.message !== undefined && body.message.trim().length > 0 ? { message: body.message.trim() } : {}),
        }
        const encodedRequestId = encodeURIComponent(body.requestId)
        // A failed mutation has an uncertain outcome. Never probe another POST route.
        return request<unknown>(
          `/permission/${encodedRequestId}`,
          { method: 'POST', body: JSON.stringify(payload) },
          PERMISSION_REQUEST_TIMEOUT_MS,
        )
      },
      sendSessionMessage: (id, body) =>
        request<OpenCodeMessage>(
          `/session/${encodeURIComponent(id)}/message`,
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
          MESSAGE_REQUEST_TIMEOUT_MS,
        ),
      promptSessionAsync: async (id, body) => {
        await request<void>(
          `/session/${encodeURIComponent(id)}/prompt_async`,
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
          MESSAGE_REQUEST_TIMEOUT_MS,
        )
      },
      abortSession: id =>
        request<boolean>(`/session/${encodeURIComponent(id)}/abort`, {
          method: 'POST',
        }),
  }
}
