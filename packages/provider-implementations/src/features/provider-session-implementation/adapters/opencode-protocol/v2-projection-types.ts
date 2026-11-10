export type OpenCodeV2NativeLogEvent = { id: string; type: string; aggregateID: string; seq: number; data: Readonly<Record<string, unknown>> }
export type OpenCodeV2NativeMessage = { id: string; type: string; timeCreated: number; data: Readonly<Record<string, unknown>> }
export type OpenCodeV2NativeTurnCut = Readonly<{
  pin: '2.0.0' | '2.0.21'; sessionID: string; nativeInputID: string
  beforeCursor: number | null; originalText: string
  messages: { data: OpenCodeV2NativeMessage[]; previous: string | null; next: string | null }
  log: { events: OpenCodeV2NativeLogEvent[]; synced: true; watermark: number | null }
}>
export type OpenCodeV2NativeToolFact = Readonly<{
  assistantMessageId: string; toolCallId: string; toolName: string
  status: 'running' | 'completed' | 'error'; executed: boolean | null
  input: unknown; content: readonly unknown[] | null; error: unknown; metadata: unknown
}>
export type OpenCodeV2NativeTurn = Readonly<{
  state: 'unknown' | 'pending' | 'succeeded' | 'failed' | 'cancelled'
  reason: string; assistantMessageIds: readonly string[]; text: string
  tools: readonly OpenCodeV2NativeToolFact[]
}>
