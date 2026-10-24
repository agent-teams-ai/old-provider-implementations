export type OpenCodeCanonicalMessageRole = 'user' | 'assistant' | 'system' | 'unknown'

export type OpenCodeCanonicalMessage = {
  id: string | null
  parentId: string | null
  role: OpenCodeCanonicalMessageRole
  agent: string | null
  providerId: string | null
  modelId: string | null
  createdAt: number | null
  completedAt: number | null
  text: string
  reasoningText: string
  previewText: string | null
  partTypes: string[]
  reasoningPartCount: number
  toolCalls: OpenCodeCanonicalToolCall[]
  contentBlocks: OpenCodeCanonicalContentBlock[]
  finishReason: string | null
  errorName: string | null
  errorMessage: string | null
  hasError: boolean
}

export type OpenCodeCanonicalToolStatus = 'running' | 'completed' | 'errored' | 'unknown'

export type OpenCodeCanonicalToolCall = {
  /** Native V1 part identity and metadata observations, not authored file images. */
  partId?: string | null
  metadata?: Record<string, unknown> | null
  callId: string | null
  toolName: string | null
  title: string | null
  status: OpenCodeCanonicalToolStatus
  input: Record<string, unknown> | null
  output: unknown
  outputText: string | null
  outputPreview: string | null
  startedAt: number | null
  completedAt: number | null
  isError: boolean
}

export type OpenCodeCanonicalContentBlock =
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'reasoning'
      text: string
    }
  | {
      type: 'tool_use'
      id: string | null
      name: string | null
      title: string | null
      status: OpenCodeCanonicalToolStatus
      input: Record<string, unknown> | null
      startedAt: number | null
      completedAt: number | null
    }
  | {
      type: 'tool_result'
      toolUseId: string | null
      toolName: string | null
      title: string | null
      status: OpenCodeCanonicalToolStatus
      contentText: string | null
      contentPreview: string | null
      rawContent: unknown
      isError: boolean
      startedAt: number | null
      completedAt: number | null
    }
  | {
      type: 'step_start'
    }
  | {
      type: 'step_finish'
      reason: string | null
    }
  | {
      type: 'error'
      name: string
      message: string
    }
