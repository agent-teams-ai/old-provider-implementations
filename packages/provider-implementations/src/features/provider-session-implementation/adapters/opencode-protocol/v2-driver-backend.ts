import type { EventPayload } from '@agent-teams/provider-session-contracts'
import type { DriverProtocol, DriverSnapshot } from './driver-protocol.ts'
import type { OpenCodeV2DriverConfig } from './v2-driver-config.ts'
import { createDriverNative } from './v2-driver-native.ts'
import type { NativeDriverInput } from './v2-driver-native.ts'
import { OpenCodeV2DriverOutput } from './v2-driver-output.ts'
import { projectOpenCodeV2NativeTurn } from './v2-turn-projection.ts'
import { terminal } from './v2-projection-helpers.ts'

export function createV2DriverBackend(config: OpenCodeV2DriverConfig, signal: AbortSignal): DriverProtocol {
  const native = createDriverNative(config, signal)
  const cancelOriginal = async (original: NativeDriverInput) => {
    const cut = await native.read(original)
    const events = cut.log.events.filter(event => event.seq > (original.beforeCursor ?? -1))
    const delivered = events.filter(event => event.type === 'session.inbox.delivered')
    if (delivered.length === 0) {
      if (events.some(event => event.type === 'session.inbox.cancelled' && event.data.inboxID === original.nativeInputID)) {return}
      await native.control(wire => wire.cancelInbox(original.nativeInputID)); return
    }
    if (delivered.length !== 1 || delivered[0]?.data.inboxID !== original.nativeInputID) {throw new Error('ambiguous_native_active_input')}
    if (events.some(event => terminal(event) && event.seq > delivered[0]!.seq)) {return}
    await native.control(wire => wire.interrupt())
  }
  return {
    pollIntervalMs: 20,
    dispose: () => native.dispose(),
    replyPermission: (requestId, decision, revoked) => native.control(wire => wire.replyPermission(requestId, decision === 'allow' ? 'once' : 'reject'), revoked),
    async queue(nativeInputID, text) {
      const original = await native.queue(nativeInputID, text)
      let facts: EventPayload[] = []
      const output = new OpenCodeV2DriverOutput(event => { facts.push(event) })
      return {
        nativeInputId: original.nativeInputID,
        interrupt: () => cancelOriginal(original),
        async read(): Promise<DriverSnapshot> {
          const empty: DriverSnapshot = { facts: [], permissions: [] }
          let cut
          try { cut = await native.read(original) }
          catch (error) { if (error instanceof Error && error.message === 'mutable_native_readback') {return empty;} throw error }
          const turn = projectOpenCodeV2NativeTurn(cut)
          facts = []; output.accept(cut, turn)
          if (turn.state === 'unknown') {return empty}
          if (turn.state !== 'pending') {return { facts, terminal: turn.state, permissions: [] }}
          const permissions = await native.control(wire => wire.pendingPermissions())
          return { facts, permissions: permissions.filter(permission => {
            const source = permission.source
            return source !== undefined && turn.assistantMessageIds.includes(source.messageID) && turn.tools.some(tool =>
              tool.assistantMessageId === source.messageID && tool.toolCallId === source.id && tool.status === 'running')
          }).map(permission => ({ requestId: permission.requestId, tool: permission.action, input: { resources: permission.resources } })) }
        },
      }
    },
  }
}
