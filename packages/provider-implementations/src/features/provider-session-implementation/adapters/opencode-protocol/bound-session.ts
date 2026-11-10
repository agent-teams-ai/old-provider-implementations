import { record } from './v2-projection-helpers.ts'
import type { OpenCodeClient } from './OpenCodeClientFactory.ts'
import { getOpenCodeSseSessionId } from './OpenCodeSseEventStream.ts'
import type { OpenCodeSseEvent } from './types.ts'

/** Technical binding supplied by the owning runtime; no team/name discovery. */
export function bindOpenCodeSession(client: OpenCodeClient, sessionId: string) {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(sessionId)) {throw new Error('Invalid native session ID')}
  return {
    sessionId,
    async read() {
      const session = await client.getSession(sessionId)
      if (session.id !== sessionId) {throw new Error('Native session identity mismatch')}
      return session
    },
    async messages(limit = 50, before?: string) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {throw new Error('Invalid message page limit')}
      const messages = await client.getSessionMessages(sessionId, limit, before)
      if (!Array.isArray(messages)) {throw new Error('Invalid native message page')}
      for (const message of messages) {
        if (record(message) === null || record(message.info) === null || !Array.isArray(message.parts)) {throw new Error('Invalid native message shape')}
        for (const value of [message.info, ...message.parts]) {
          if (record(value) === null) {throw new Error('Invalid native message part')}
          const owner = value.sessionID ?? value.sessionId
          if (owner !== undefined && owner !== sessionId) {throw new Error('Native message session identity mismatch')}
        }
      }
      // Missing native attribution remains missing; the request URL does not create evidence.
      return messages
    },
    prompt: (input: Parameters<OpenCodeClient['promptSessionAsync']>[1]) => client.promptSessionAsync(sessionId, input),
    interrupt: () => client.abortSession(sessionId),
    acceptsEvent: (event: OpenCodeSseEvent) => getOpenCodeSseSessionId(event.properties) === sessionId,
    async replyPermission(requestId: string, decision: 'allow' | 'always' | 'reject') {
      const requests = await client.getPermissions()
      if (!Array.isArray(requests)) {throw new Error('Invalid native permission list')}
      const request = requests.find(value =>
        (value.id ?? value.requestID ?? value.requestId ?? value.permissionID ?? value.permissionId) === requestId)
      const owner = request?.sessionID ?? request?.sessionId ?? request?.session
      if (owner !== sessionId) {throw new Error('Permission is missing or belongs to another session')}
      return client.answerPermission({ requestId, sessionId, decision })
    },
  }
}
