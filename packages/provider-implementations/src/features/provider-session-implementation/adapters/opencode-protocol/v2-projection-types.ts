export type OpenCodeV2NativeLogEvent = { id: string; type: string; aggregateID: string; seq: number; data: Readonly<Record<string, unknown>> }
export type OpenCodeV2NativeMessage = { id: string; type: string; timeCreated: number; data: Readonly<Record<string, unknown>> }
export type OpenCodeV2NativeTurnCut = Readonly<{
  pin: '2.0.0' | '2.0.21' | '2.1.4'; sessionID: string; nativeInputID: string
  beforeCursor: number | null; originalText: string
  originalFilesDigest?: string
  messages: { data: OpenCodeV2NativeMessage[]; previous: string | null; next: string | null }
  log: { events: OpenCodeV2NativeLogEvent[]; synced: true; watermark: number | null }
}>
export type OpenCodeV2NativeToolFact = Readonly<{
  assistantMessageId: string; toolCallId: string; toolName: string
  // Upstream event.data.executed is the *provider-hosted execution* bit. A
  // locally executed built-in tool may succeed with this bit false; it is NOT
  // proof that the tool caused no physical side effects.
  status: 'running' | 'completed' | 'error'; providerExecuted: boolean | null
  input: unknown; content: readonly unknown[] | null; error: unknown; metadata: unknown
  /** Original immutable log identities; completed is absent while the native tool is running. */
  calledEvent?: Readonly<{ id: string; seq: number }>
  completedEvent?: Readonly<{ id: string; seq: number; type: 'session.tool.success' | 'session.tool.failed' }>
}>
export type OpenCodeV2NativeTurn = Readonly<{
  state: 'unknown' | 'pending' | 'succeeded' | 'failed' | 'cancelled'
  terminalCode?: 'unsupported'
  reason: string; assistantMessageIds: readonly string[]; text: string
  tools: readonly OpenCodeV2NativeToolFact[]
}>
