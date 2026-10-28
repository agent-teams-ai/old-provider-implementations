import type { OpenCodeInputWindowItem, OpenCodeInputWindowPort } from './input-window-capture.ts'
import type { EventPayload, Limits } from '@agent-teams/provider-session-contracts'
import type { AttachmentPort, PreparedAttachment } from '../provider-session-io/attachments.ts'

/** Private seam for the two actual native dialects; no runtime ownership or native DTOs. */
export type DriverPermission = { requestId: string; tool: string; input: unknown }
export type DriverSnapshot = { facts: readonly EventPayload[]; observations?: readonly OpenCodeInputWindowItem[]; terminal?: 'succeeded' | 'failed' | 'cancelled' | undefined; permissions: readonly DriverPermission[] }
export type DriverTurn = { nativeInputId: string; read: () => Promise<DriverSnapshot>; interrupt: () => Promise<void> }
export type DriverProtocol = {
  pollIntervalMs: number
  dispose: () => Promise<void>
  queue: (operationKey: string, text: string, attachments?: readonly PreparedAttachment[]) => Promise<DriverTurn>
  replyPermission: (requestId: string, decision: 'allow' | 'deny', signal: AbortSignal) => Promise<void>
}
export type DriverSessionConfig = {
  binding: Readonly<{ tenantId: string; projectId: string; sessionId: string; generation: number }>
  nativeSessionId: string; trustedBinding: string; engine: 'opencode-v1' | 'opencode-v2'; compatibility: string
  limits: Limits
  attachments?: AttachmentPort
  attachmentModel?: string
  capture?: OpenCodeInputWindowPort
  probe: (signal: AbortSignal) => Promise<boolean>
  confirmStopped: () => Promise<boolean>
}
