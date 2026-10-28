import { setTimeout as delay } from 'node:timers/promises'
import type { DriverProtocol } from './driver-protocol.ts'
import type { OpenCodeV1DriverConfig } from './v1-driver-config.ts'
import { buildOpenCodeRuntimePromptMessageId, getGreatestOpenCodePromptOrderingMessageId } from './OpenCodeMessageIds.ts'
import { createV1DriverWire, v1NotSubmitted } from './v1-driver-wire.ts'
import { readV1Window } from './v1-native-read.ts'
import { readV1DriverCut, verifyV1Session } from './v1-driver-cut.ts'
import { createV1DriverOutput } from './v1-driver-output.ts'
import { assertSerializedAttachments } from '../provider-session-io/attachments.ts'

export function createV1DriverBackend(config: OpenCodeV1DriverConfig, signal: AbortSignal): DriverProtocol {
  const wire = createV1DriverWire(config, signal)
  const turns = new Map<string, { id: string; text: string }>()
  return {
    pollIntervalMs: 100,
    dispose: () => wire.dispose(),
    async replyPermission(requestId, decision, revoked) {
      const owner = turns.get(requestId)
      if (!owner) {throw v1NotSubmitted('stale_native_permission')}
      await wire.use(async (client, questions) => {
        try {
          const cut = await readV1DriverCut(client, questions, config, owner.id, owner.text)
          if (cut?.permissions.some(value => value.requestId === requestId) !== true) {throw new Error('stale')}
          revoked.throwIfAborted()
        } catch { throw v1NotSubmitted('native_permission_preflight') }
        await client.answerPermission({ requestId, sessionId: config.nativeSessionId, decision: decision === 'allow' ? 'allow' : 'reject' })
        turns.delete(requestId)
      }, revoked)
    },
    async queue(operationKey, text, attachments = []) {
      turns.clear()
      const parts = [{ type: 'text', text }, ...attachments.map(item => ({ type: 'file', mime: item.reference.mimeType,
        url: 'data:' + item.reference.mimeType + ';base64,' + Buffer.from(item.bytes).toString('base64'), filename: item.reference.artifactId }))]
      assertSerializedAttachments(parts)
      const nativeInputID = await wire.use(async client => {
        let id: string
        try {
          await verifyV1Session(client, config)
          const messages = await readV1Window(client, config.nativeSessionId)
          // Retain donor's exclusion of old random128-bit msg_0... IDs from ascending ordering.
          const greatest = getGreatestOpenCodePromptOrderingMessageId(messages.map(value => String(value.info.id)).filter(value => !/^msg_0[0-9a-f]{31}$/.test(value)))
          id = ''
          for (let attempt = 0; attempt < 16; attempt++) {
            const candidate = buildOpenCodeRuntimePromptMessageId({ randomSuffix: operationKey.slice(-14) })
            if (greatest === null || candidate > greatest) { id = candidate; break }
            await delay(1, undefined, { signal })
          }
          if (!id) {throw new Error('unqualified_native_id_order')}
        } catch { throw v1NotSubmitted('native_preflight') }
        await client.promptSessionAsync(config.nativeSessionId, { messageID: id, model: config.model,
          ...(config.agent !== undefined && config.agent.length > 0 ? { agent: config.agent } : {}), ...(config.variant !== undefined && config.variant.length > 0 ? { variant: config.variant } : {}), parts })
        return id
      })
      const output = createV1DriverOutput()
      return {
        nativeInputId: nativeInputID,
        async read() {
          const cut = await wire.use((client, questions) => readV1DriverCut(client, questions, config, nativeInputID, text))
          if (!cut) {return { facts: [], permissions: [] }}
          for (const permission of cut.permissions) {turns.set(permission.requestId, { id: nativeInputID, text })}
          return { facts: output(cut), terminal: cut.terminal, permissions: cut.permissions,
            ...(config.capture ? { observations: cut.messages.flatMap(message => message.toolCalls.flatMap(tool =>
              typeof message.id === 'string' && message.id.length > 0 && typeof tool.partId === 'string' && tool.partId.length > 0
                && typeof tool.callId === 'string' && tool.callId.length > 0 && typeof tool.toolName === 'string' && tool.toolName.length > 0 ? [{ messageId: message.id, partId: tool.partId,
                callId: tool.callId, tool: tool.toolName, status: tool.status, input: tool.input, metadata: tool.metadata ?? null,
                startedAt: tool.startedAt, completedAt: tool.completedAt }] : [])) } : {}) }
        },
        async interrupt() {
          turns.clear()
          await wire.use(async (client, questions) => {
            const cut = await readV1DriverCut(client, questions, config, nativeInputID, text)
            if (!cut) {throw new Error('unknown_native_turn')}
            if (!cut.terminal && typeof await client.abortSession(config.nativeSessionId) !== 'boolean') {throw new Error('invalid_native_abort_receipt')}
          })
        },
      }
    },
  }
}
