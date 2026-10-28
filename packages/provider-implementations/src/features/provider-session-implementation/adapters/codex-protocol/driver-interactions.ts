import { codexQuestionPlan, codexQuestionReply, codexQuestions, denyCodexQuestion, isCodexQuestionMethod } from './user-questions.ts'
import type { CodexQuestionPlan } from './user-questions.ts'
import { randomUUID } from 'node:crypto'
import type { EventPayload, InteractionReply, Reply } from '@agent-teams/provider-session-contracts'
import { deferred } from '../provider-session-io/io.ts'
import type { CodexAppServerToolApprovalRequest } from '../../contracts/codex-approval.ts'
import type { CodexApprovalReply } from './approval-response.ts'

type Pending = { question?: CodexQuestionPlan; owner: object; request: CodexAppServerToolApprovalRequest; done: ReturnType<typeof deferred<CodexApprovalReply>>; signal: AbortSignal }
const decision = (request: CodexAppServerToolApprovalRequest, allow: boolean): CodexApprovalReply => isCodexQuestionMethod(request.method) ? denyCodexQuestion(request.method) : ({ kind: 'decision',
  decision: request.method === 'execCommandApproval' || request.method === 'applyPatchApproval' ? (allow ? 'approved' : 'denied') : (allow ? 'accept' : 'decline') })
function permissionDecision(value: unknown): 'allow' | 'deny' | undefined {
  try {
    if (value === null || typeof value !== 'object') {return undefined}
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {return undefined}
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !('value' in descriptors[key]!))) {return undefined}
    const kind: unknown = descriptors.kind?.value, selected: unknown = descriptors.decision?.value
    return kind === 'permission' && (selected === 'allow' || selected === 'deny') ? selected : undefined
  } catch { return undefined }
}

/** One-turn decisions only; canonical allow never becomes a session-wide native grant. */
export class CodexDriverInteractions {
  private readonly pending = new Map<string, Pending>()
  private readonly limit: number
  private readonly emit: (event: EventPayload, owner: object) => void
  constructor(limit: number, emit: (event: EventPayload, owner: object) => void) { this.limit = limit; this.emit = emit }
  async request(request: CodexAppServerToolApprovalRequest, signal: AbortSignal, owner: object): Promise<CodexApprovalReply> {
    if (request.method === 'item/permissions/requestApproval') {
      this.emit({ kind: 'diagnostic', code: 'unsupported' }, owner)
      return { kind: 'permissions', permissions: {}, scope: 'turn' }
    }
    const question = isCodexQuestionMethod(request.method) ? codexQuestionPlan(request) : undefined
    if (isCodexQuestionMethod(request.method) && !question) {
      this.emit({ kind: 'diagnostic', code: 'unsupported' }, owner)
      return denyCodexQuestion(request.method)
    }
    const cancelled = (): boolean => signal.aborted
    if (cancelled()) {return decision(request, false)}
    if (this.pending.size >= this.limit) {throw new Error('codex.driver.interaction-limit')}
    const ref = randomUUID(); const pending: Pending = { owner, request, signal, ...(question ? { question } : {}), done: deferred() }
    const abort = () => { this.pending.delete(ref); pending.done.resolve(decision(request, false)) }
    signal.addEventListener('abort', abort, { once: true }); this.pending.set(ref, pending)
    try {
      if (cancelled()) {abort()}
      else {this.emit({ kind: 'interaction', interactionRef: ref, request: question ? { kind: 'question', questions: codexQuestions(question) } : { kind: 'permission', tool: request.toolName, input: structuredClone(request.toolInput) } }, owner)}
      return await pending.done.promise
    } finally { signal.removeEventListener('abort', abort); this.pending.delete(ref) }
  }
  respond(ref: string, reply: InteractionReply, owner: object | undefined): Reply<void> {
    const pending = this.pending.get(ref)
    if (!pending || !owner || pending.owner !== owner || pending.signal.aborted) {return { ok: false, code: 'stale' }}
    if (pending.question) {
      const answer = codexQuestionReply(pending.question, reply)
      if (!answer) { return { ok: false, code: 'unsupported' } }
      this.pending.delete(ref); pending.done.resolve(answer)
      return { ok: true, value: undefined }
    }
    const selected = permissionDecision(reply)
    if (selected === undefined) {return { ok: false, code: 'unsupported' }}
    const result = decision(pending.request, selected === 'allow')
    const available = pending.request.raw.availableDecisions
    if (result.kind === 'decision' && Array.isArray(available) && !available.includes(result.decision)) {return { ok: false, code: 'unsupported' }}
    this.pending.delete(ref); pending.done.resolve(result)
    return { ok: true, value: undefined }
  }
  get size(): number { return this.pending.size }
}
