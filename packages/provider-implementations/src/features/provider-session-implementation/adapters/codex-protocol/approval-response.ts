import { isCodexAppServerApprovalMethod } from './approval-request.ts'
import type { CodexAppServerRequest, CodexAppServerRequestId } from '../../contracts/codex-approval.ts'

/** An already-authorized wire decision, selected by the consuming runtime. */
export type CodexApprovalReply =
  | { readonly kind: 'decision'; readonly decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' | 'approved' | 'denied' }
  | { readonly kind: 'elicitation'; readonly action: 'accept' | 'decline'; readonly content: Readonly<Record<string, string | boolean>> | null }
  | { readonly kind: 'user-input'; readonly answers: Readonly<Record<string, { readonly answers: readonly string[] }>> }
  | { readonly kind: 'permissions'; readonly permissions: Readonly<Record<string, unknown>>; readonly scope: 'turn' }

export type CodexApprovalResponse = {
  readonly jsonrpc: '2.0'
  readonly id: CodexAppServerRequestId
  readonly result: Readonly<Record<string, unknown>>
}

function reject(): never {
  throw new Error('codex.protocol.unsupported-decision')
}
function turnScope(scope: unknown): boolean { return scope === 'turn' }

/** Pure encoding only. Never selects an approval policy or escalates a grant. */
export function encodeCodexApprovalResponse(
  request: Pick<CodexAppServerRequest, 'id' | 'method' | 'params'>,
  reply: CodexApprovalReply,
): CodexApprovalResponse {
  if (!isCodexAppServerApprovalMethod(request.method)) {return reject()}
  if (request.method === 'mcpServer/elicitation/request') {
    if (reply.kind !== 'elicitation' || !['accept', 'decline'].includes(reply.action)) { return reject() }
    return { jsonrpc: '2.0', id: request.id, result: { action: reply.action, content: reply.content, _meta: null } }
  }
  if (request.method === 'item/tool/requestUserInput') {
    if (reply.kind !== 'user-input') { return reject() }
    return { jsonrpc: '2.0', id: request.id, result: { answers: reply.answers } }
  }
  if (request.method === 'item/permissions/requestApproval') {
    if (reply.kind !== 'permissions' || !turnScope(reply.scope)) {return reject()}
    if (Object.keys(reply.permissions).some(key => key !== 'network' && key !== 'fileSystem')) {return reject()}
    return { jsonrpc: '2.0', id: request.id, result: { permissions: reply.permissions, scope: 'turn' } }
  }
  if (reply.kind !== 'decision') {return reject()}
  const legacy = request.method === 'execCommandApproval' || request.method === 'applyPatchApproval'
  const valid = legacy ? ['approved', 'denied'] : ['accept', 'decline', 'cancel', 'acceptForSession']
  if (!valid.includes(reply.decision)) {return reject()}
  const available = request.params?.availableDecisions
  if (Array.isArray(available) && !available.includes(reply.decision)) {return reject()}
  return { jsonrpc: '2.0', id: request.id, result: { decision: reply.decision } }
}
