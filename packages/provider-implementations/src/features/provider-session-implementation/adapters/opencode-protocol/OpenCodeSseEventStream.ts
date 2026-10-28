import type { OpenCodeSseEvent } from './types.ts'

export type OpenCodeSseFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type OpenCodeSseEndpoint = '/event' | '/global/event'

export type OpenCodeSseEndpointReadResult = {
  endpoint: OpenCodeSseEndpoint
  connected: boolean
  closedBeforeAbort: boolean
  observedEventCount: number
  diagnostics: string[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function getOpenCodeSseSessionId(properties: Record<string, unknown>): string | null {
  return (
    asString(properties.sessionID)
    ?? asString(properties.sessionId)
    ?? asString(asRecord(properties.info)?.sessionID)
    ?? asString(asRecord(properties.info)?.sessionId)
    ?? asString(asRecord(properties.part)?.sessionID)
    ?? asString(asRecord(properties.part)?.sessionId)
  )
}

export function getOpenCodeSseMessageId(properties: Record<string, unknown>): string | null {
  return (
    asString(asRecord(properties.info)?.id)
    ?? asString(asRecord(properties.part)?.messageID)
    ?? asString(asRecord(properties.part)?.messageId)
    ?? asString(properties.messageID)
    ?? asString(properties.messageId)
  )
}

export function getOpenCodeSseMessageRole(properties: Record<string, unknown>): string | null {
  return asString(asRecord(properties.info)?.role)
}

export function getOpenCodeSseMessageParentId(properties: Record<string, unknown>): string | null {
  const info = asRecord(properties.info)
  return (
    asString(info?.parentID)
    ?? asString(info?.parentId)
    ?? asString(info?.parent)
  )
}

export function getOpenCodeSsePartType(properties: Record<string, unknown>): string | null {
  return asString(asRecord(properties.part)?.type)
}

export function getOpenCodeSseSessionStatusType(
  status: unknown,
  sessionId?: string | null,
): string | null {
  const direct = asString(status)
  if (direct !== null) {
    return direct
  }

  const record = asRecord(status)
  if (!record) {
    return null
  }

  const typed = asString(record.type)
  if (typed !== null) {
    return typed
  }

  if (sessionId === undefined || sessionId === null || sessionId.length === 0) {
    return null
  }

  const scoped = record[sessionId]
  return asString(scoped) ?? asString(asRecord(scoped)?.type)
}

export function normalizeOpenCodeSseEvent(raw: unknown): OpenCodeSseEvent | null {
  const record = asRecord(raw)
  if (!record) {
    return null
  }

  const directType = asString(record.type)
  const payload = asRecord(record.payload)
  const eventRecord = directType !== null ? record : payload
  if (!eventRecord) {
    return null
  }

  const type = asString(eventRecord.type)
  if (type === null) {
    return null
  }

  return {
    type,
    properties: asRecord(eventRecord.properties) ?? {},
    directory: asString(record.directory),
    raw,
  }
}

export function parseOpenCodeSseDataBlocks(input: string): string[] {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n\n')
}

export function extractOpenCodeSseData(block: string): string | null {
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) {
      continue
    }
    if (!line.startsWith('data:')) {
      continue
    }

    let data = line.slice(5)
    if (data.startsWith(' ')) {
      data = data.slice(1)
    }
    dataLines.push(data)
  }

  return dataLines.length > 0 ? dataLines.join('\n') : null
}

function sseRequest(signal: AbortSignal | undefined): RequestInit {
  return { method: 'GET', ...(signal === undefined ? {} : { signal }), headers: { Accept: 'text/event-stream' } }
}
function validatedSseBody(response: Response, endpoint: OpenCodeSseEndpoint): { body: ReadableStream<Uint8Array> } | { problem: string } {
  if (!response.ok) { return { problem: `OpenCode SSE endpoint ${endpoint} returned ${response.status} ${response.statusText}` } }
  if (response.headers.get('content-type')?.includes('text/event-stream') !== true) { return { problem: `OpenCode SSE endpoint ${endpoint} did not return text/event-stream` } }
  if (!response.body) { return { problem: `OpenCode SSE endpoint ${endpoint} returned no stream body` } }
  return { body: response.body }
}
export async function readOpenCodeSseEndpoint(params: {
  baseUrl: string
  endpoint: OpenCodeSseEndpoint
  fetchImpl?: OpenCodeSseFetch
  signal?: AbortSignal
  onEvent(event: OpenCodeSseEvent): void
}): Promise<OpenCodeSseEndpointReadResult> {
  const diagnostics: string[] = []
  const diagnose = (message: string) => { if (diagnostics.length < 32) {diagnostics.push(message)} }
  const consumeData = (data: string | null, trailing: boolean): void => {
    if (data === null || data.length === 0) { return }
    try {
      const event = normalizeOpenCodeSseEvent(JSON.parse(data))
      if (!event) {
        if (!trailing) { diagnose('OpenCode SSE ignored an unrecognized payload shape') }
        return
      }
      // Count before callback: a throwing callback was already an observed native event.
      observedEventCount += 1
      params.onEvent(event)
    } catch {
      diagnose(trailing ? 'OpenCode SSE ignored malformed trailing payload - request or payload rejected' : 'OpenCode SSE ignored malformed payload - request or payload rejected')
    }
    return
  }
  const fetchImpl = params.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(params.baseUrl + params.endpoint, sseRequest(params.signal))
  } catch {
    if (params.signal?.aborted !== true) { diagnose(`OpenCode SSE failed to connect to ${params.endpoint} - request or payload rejected`) }
    return { endpoint: params.endpoint, connected: false, closedBeforeAbort: false, observedEventCount: 0, diagnostics }
  }

  const validated = validatedSseBody(response, params.endpoint)
  if ('problem' in validated) {
    diagnose(validated.problem)
    return { endpoint: params.endpoint, connected: false, closedBeforeAbort: false, observedEventCount: 0, diagnostics }
  }

  let observedEventCount = 0
  let buffer = ''
  let reachedEof = false
  const reader = validated.body.getReader()
  const decoder = new TextDecoder()
  const cancelReader = () => { void reader.cancel(params.signal?.reason).catch(() => {}) }
  params.signal?.addEventListener('abort', cancelReader, { once: true })
  if (params.signal?.aborted === true) {cancelReader()}
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        reachedEof = true
        break
      }
      buffer += decoder.decode(value, { stream: true })
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        await reader.cancel()
        diagnose('OpenCode SSE event byte budget exceeded')
        buffer = ''
        break
      }
      const blocks = parseOpenCodeSseDataBlocks(buffer)
      buffer = blocks.pop() ?? ''
      for (const block of blocks) { consumeData(extractOpenCodeSseData(block), false) }
    }

    consumeData(extractOpenCodeSseData(buffer), true)
  } catch {
    if (params.signal?.aborted !== true) {
      diagnose(
        `OpenCode SSE stream ${params.endpoint} failed - request or payload rejected`,
      )
    }
  } finally {
    params.signal?.removeEventListener('abort', cancelReader)
    reader.releaseLock()
  }

  return {
    endpoint: params.endpoint,
    connected: true,
    closedBeforeAbort: reachedEof && params.signal?.aborted !== true,
    observedEventCount,
    diagnostics,
  }
}
