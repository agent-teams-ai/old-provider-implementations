import type { InteractionReply } from '@agent-teams/provider-session-contracts'
import type { CodexAppServerToolApprovalRequest } from '../../contracts/codex-approval.ts'
import type { CodexApprovalReply } from './approval-response.ts'
import { record } from './wire-frames.ts'

type Choice = { label: string; value: string | boolean; description?: string }
type Field = { id: string; question: string; header: string; options: Choice[] }
export type CodexQuestionPlan = { kind: 'user-input' | 'elicitation'; fields: Field[]; empty?: true }
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
const keys = (row: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(row).every(key => allowed.includes(key))
const persistent = (label: string): boolean => label === 'Allow for this session' || label === "Allow and don't ask me again"
export const isCodexQuestionMethod = (method: string): boolean => method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request'
export const denyCodexQuestion = (method: string): CodexApprovalReply => method === 'mcpServer/elicitation/request'
  ? { kind: 'elicitation', action: 'decline', content: null } : { kind: 'user-input', answers: {} }

function nativeQuestion(value: unknown): Field | undefined {
  const row = record(value)
  if (!row || !keys(row, ['id', 'header', 'question', 'isOther', 'isSecret', 'options']) || !text(row.id) || !text(row.header, 128) || !text(row.question) ||
    (row.isOther !== undefined && row.isOther !== false) || (row.isSecret !== undefined && row.isSecret !== false) || !Array.isArray(row.options) || row.options.length > 32) { return undefined }
  const options: Choice[] = []
  for (const option of row.options) {
    const selected = record(option)
    if (!selected || !keys(selected, ['label', 'description']) || !text(selected.label, 128) || !text(selected.description, 512)) { return undefined }
    if (!persistent(selected.label)) { options.push({ label: selected.label, value: selected.label, description: selected.description }) }
  }
  return options.length > 0 && new Set(options.map(option => option.label)).size === options.length
    ? { id: row.id, question: row.question, header: row.header, options } : undefined
}
function userInput(params: Record<string, unknown>): CodexQuestionPlan | undefined {
  if (!keys(params, ['threadId', 'turnId', 'itemId', 'questions', 'isBlocking', 'autoResolutionMs']) || !text(params.itemId) ||
    (params.isBlocking !== undefined && params.isBlocking !== true) || (params.autoResolutionMs !== undefined && params.autoResolutionMs !== null) ||
    !Array.isArray(params.questions) || params.questions.length === 0 || params.questions.length > 16) { return undefined }
  const fields: Field[] = []
  for (const value of params.questions) { const field = nativeQuestion(value); if (!field) { return undefined } fields.push(field) }
  return uniqueFields(fields) ? { kind: 'user-input', fields } : undefined
}
function uniqueFields(fields: Field[]): boolean {
  return new Set(fields.map(field => field.id)).size === fields.length && new Set(fields.map(field => field.question)).size === fields.length
}
function formOptions(schema: Record<string, unknown>): Choice[] | undefined {
  if (!keys(schema, ['type', 'title', 'description', 'enum']) || (schema.title !== undefined && !text(schema.title, 128)) ||
    (schema.description !== undefined && !text(schema.description, 512))) { return undefined }
  if (schema.type === 'boolean' && schema.enum === undefined) { return [{ label: 'Yes', value: true }, { label: 'No', value: false }] }
  if (schema.type !== 'string' || !Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 32 ||
    !schema.enum.every(value => text(value, 128)) || new Set(schema.enum).size !== schema.enum.length || schema.enum.some(value => persistent(value))) { return undefined }
  return schema.enum.map(value => ({ label: value, value }))
}
function formProperties(value: unknown): Record<string, unknown> | undefined {
  const schema = record(value), properties = record(schema?.properties)
  if (!schema || !keys(schema, ['$schema', 'type', 'properties', 'required']) || schema.type !== 'object' || !properties || Object.keys(properties).length > 16 ||
    (schema.$schema !== undefined && !text(schema.$schema, 512)) ||
    (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(name => typeof name === 'string' && Object.hasOwn(properties, name))))) { return undefined }
  return properties
}
function form(params: Record<string, unknown>): CodexQuestionPlan | undefined {
  const properties = formProperties(params.requestedSchema)
  if (!keys(params, ['threadId', 'turnId', 'serverName', 'mode', '_meta', 'message', 'requestedSchema']) || params.mode !== 'form' || !text(params.serverName, 128) || !text(params.message) || !properties) { return undefined }
  const fields: Field[] = []
  for (const [id, value] of Object.entries(properties)) {
    const property = record(value); if (!text(id, 128) || !property) { return undefined }
    const options = formOptions(property), title = property.title ?? id
    if (!options || typeof title !== 'string') { return undefined }
    const question = `${params.message} — ${title}`
    if (!text(question)) { return undefined }
    fields.push({ id, question, header: params.serverName, options })
  }
  if (!fields.length) { return { kind: 'elicitation', empty: true, fields: [{ id: '', question: params.message, header: params.serverName, options: [{ label: 'Allow this request', value: true }] }] } }
  return uniqueFields(fields) ? { kind: 'elicitation', fields } : undefined
}
/** Finite existing question UI only. No URLs, authentication, secrets, free text or persistent grants. */
export function codexQuestionPlan(request: CodexAppServerToolApprovalRequest): CodexQuestionPlan | undefined {
  return request.method === 'item/tool/requestUserInput' ? userInput(request.raw) : form(request.raw)
}
export function codexQuestions(plan: CodexQuestionPlan): unknown {
  return plan.fields.map(field => ({ question: field.question, header: field.header, multiSelect: false,
    options: field.options.map(({ label, description }) => ({ label, ...(description !== undefined && description.length > 0 ? { description } : {}) })) }))
}
function data(value: unknown): Record<string, unknown> | undefined {
  try {
    const row = record(value); if (!row) { return undefined }
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) { return undefined }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !('value' in descriptors[key]!))) { return undefined }
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
  } catch { return undefined }
}
export function codexQuestionReply(plan: CodexQuestionPlan, reply: InteractionReply): CodexApprovalReply | undefined {
  const row = data(reply)
  if (!row || row.kind !== 'question') { return undefined }
  if (row.decision === 'deny' && keys(row, ['kind', 'decision'])) { return denyCodexQuestion(plan.kind === 'elicitation' ? 'mcpServer/elicitation/request' : 'item/tool/requestUserInput') }
  const answers = data(row.answers)
  if (!keys(row, ['kind', 'answers']) || !answers || Object.keys(answers).length !== plan.fields.length) { return undefined }
  const values: [string, string | boolean][] = []
  for (const field of plan.fields) {
    const selected = field.options.find(option => option.label === answers[field.question])
    if (!selected) { return undefined } values.push([field.id, selected.value])
  }
  return plan.kind === 'elicitation' ? { kind: 'elicitation', action: 'accept', content: plan.empty ? {} : Object.fromEntries(values) }
    : { kind: 'user-input', answers: Object.fromEntries(values.map(([id, value]) => [id, { answers: [String(value)] }])) }
}
