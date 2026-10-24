import { createHash } from 'node:crypto';
import type { EventPayload, FailureCode } from '@agent-teams/provider-session-contracts';
export type Fact = EventPayload;
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}
export class OutputLimitError extends Error {}
export class Normalizer {
  private streamMessage: string | undefined;
  private readonly blocks = new Map<string, string>();
  private readonly completeIndex = new Map<string, number>();
  private readonly seenWrappers = new Set<string>();
  // Session-lifetime tombstones survive turn resets; never evict and replay a boundary.
  private readonly compactions = new Set<string>();
  private readonly maxBytes: number;
  constructor(maxBytes: number) { this.maxBytes = maxBytes; }
  reset(): void { this.streamMessage = undefined; this.blocks.clear(); this.completeIndex.clear(); this.seenWrappers.clear(); }
  normalize(value: unknown): { facts: Fact[]; terminal?: 'succeeded' | 'failed' | 'unknown'; failure?: FailureCode } {
    const m = record(value);
    if (m.type === 'system' && m.subtype === 'compact_boundary') {
      if (typeof m.uuid !== 'string' || !m.uuid || typeof m.session_id !== 'string' || !m.session_id) {
        return { facts: [{ kind: 'diagnostic', code: 'unknown-event' }] };
      }
      const sourceRef = createHash('sha256').update(JSON.stringify([m.session_id, m.uuid])).digest('hex');
      if (this.compactions.has(sourceRef)) { return { facts: [] }; }
      if ((this.compactions.size + 1) * 64 > this.maxBytes) { throw new OutputLimitError('output-limit'); }
      this.compactions.add(sourceRef);
      const trigger = record(m.compact_metadata).trigger;
      return { facts: [{ kind: 'compaction', sourceRef, reason: trigger === 'auto' ? 'automatic' : trigger === 'manual' ? 'manual' : 'unknown' }] };
    }
    if (m.type === 'stream_event') {return { facts: this.partial(record(m.event)) };}
    if (m.type === 'assistant') {
      if (typeof m.uuid === 'string' && this.seenWrappers.has(m.uuid)) {return { facts: [] };}
      if (typeof m.uuid === 'string') {this.seenWrappers.add(m.uuid);}
      return { facts: this.assistant(record(m.message)) };
    }
    if (m.type === 'user') {return { facts: this.toolResults(record(m.message)) };}
    if (m.type === 'result') {return this.result(m);}
    if (m.type === 'control_request' || m.type === 'control_response') {return { facts: [], terminal: 'unknown', failure: 'unsupported' };}
    return { facts: [{ kind: 'diagnostic', code: 'unknown-event' }] };
  }
  private partial(e: Record<string, unknown>): Fact[] {
    if (e.type === 'message_start') { const id = record(e.message).id; this.streamMessage = typeof id === 'string' ? id : '';  return []; }
    if (this.streamMessage === undefined || this.streamMessage.length === 0 || typeof e.index !== 'number') {return [];}
    const key = `${this.streamMessage}:${e.index}`;
    if (e.type === 'content_block_start') {
      const b = record(e.content_block);
      if (b.type === 'text') {this.blocks.set(key, typeof b.text === 'string' ? b.text : '');}
    }
    if (e.type !== 'content_block_delta' || record(e.delta).type !== 'text_delta') {return [];}
    const delta = record(e.delta).text;
    if (typeof delta !== 'string') {return [];}
    const text = (this.blocks.get(key) ?? '') + delta;
    if (Buffer.byteLength(text) > this.maxBytes) {throw new OutputLimitError('output-limit');}
    this.blocks.set(key, text);
    return [{ kind: 'text', messageRef: this.streamMessage, block: e.index, text, phase: 'snapshot' }];
  }
  private assistant(message: Record<string, unknown>): Fact[] {
    if (typeof message.id !== 'string' || !Array.isArray(message.content)) {return [];}
    const facts: Fact[] = [];
    let index = this.completeIndex.get(message.id) ?? 0;
    for (const value of message.content) {
      const b = record(value);
      if (b.type === 'text' && typeof b.text === 'string') {facts.push({ kind: 'text', messageRef: message.id, block: index, text: b.text, phase: 'complete' });}
      if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {facts.push({ kind: 'tool', messageRef: message.id, toolRef: b.id, name: b.name, input: b.input });}
      index += 1;
    }
    this.completeIndex.set(message.id, index);
    return facts;
  }
  private toolResults(message: Record<string, unknown>): Fact[] {
    if (!Array.isArray(message.content)) {return [];}
    return message.content.flatMap((value) => {
      const b = record(value);
      return b.type === 'tool_result' && typeof b.tool_use_id === 'string' ? [{ kind: 'tool-result' as const, toolRef: b.tool_use_id, content: b.content, isError: b.is_error === true }] : [];
    });
  }
  private result(m: Record<string, unknown>): ReturnType<Normalizer['normalize']> {
    const usage = record(m.usage);
    const facts: Fact[] = [{ kind: 'usage',
      ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
      ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
      ...(typeof m.total_cost_usd === 'number' ? { cumulativeCostUsd: m.total_cost_usd } : {}),
    }];
    if (m.subtype === 'success') {return { facts, terminal: m.is_error === true ? 'failed' : 'succeeded' };}
    if (['error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries'].includes(String(m.subtype))) {return { facts, terminal: 'failed', failure: 'provider-failure' };}
    return { facts, terminal: 'unknown', failure: 'unsupported' };
  }
}
