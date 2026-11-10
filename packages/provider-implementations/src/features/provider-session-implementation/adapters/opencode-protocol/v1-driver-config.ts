import { snapshotOpenCodeCapture } from './input-window-capture.ts'
import type { OpenCodeInputWindowPort } from './input-window-capture.ts'
import { record } from './v2-projection-helpers.ts'
import { createHash } from 'node:crypto'
import type { Limits, OpenConfig } from '@agent-teams/provider-session-contracts'
import { attachmentCompatibility, snapshotAttachmentPort } from '../provider-session-io/attachments.ts'
import type { AttachmentPort } from '../provider-session-io/attachments.ts'
export type OpenCodeV1DriverConfig = {
  endpoint: string; version: string; workspacePath: string; nativeSessionId: string
  trustedBinding: string; accountBinding: string; profileBinding: string; runBinding: string
  configRevision: string; binding: Readonly<{ tenantId: string; projectId: string; sessionId: string; generation: number }>
  model: Readonly<{ providerID: string; modelID: string }>; agent?: string; variant?: string
  limits: Limits
  attachments?: AttachmentPort
  capture?: OpenCodeInputWindowPort
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  /** Exact CLI/Host/profile/MCP/model custody, read-only and generation-aware. */
  probe: (signal: AbortSignal) => Promise<boolean>
  confirmStopped: () => Promise<boolean>
}
export function v1Compatibility(c: OpenCodeV1DriverConfig): string {
  return createHash('sha256').update(JSON.stringify({ endpoint: c.endpoint, version: c.version, workspace: c.workspacePath,
    native: c.nativeSessionId, trusted: c.trustedBinding, account: c.accountBinding, profile: c.profileBinding,
    run: c.runBinding, revision: c.configRevision, tenant: c.binding.tenantId, project: c.binding.projectId,
    session: c.binding.sessionId, model: { providerID: c.model.providerID, modelID: c.model.modelID }, agent: c.agent, variant: c.variant,
    ...(c.attachments ? { attachments: attachmentCompatibility(c.attachments) } : {}) })).digest('hex')
}
export function snapshotV1Config(c: OpenCodeV1DriverConfig, request: OpenConfig): OpenCodeV1DriverConfig {
  if (record(c) === null || !/^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(c.version) || Number(c.version.split('.')[1]) < 16
    || !/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(c.endpoint) || !c.workspacePath.startsWith('/')
    || !/^ses_[A-Za-z0-9]+$/.test(c.nativeSessionId) || c.configRevision !== request.configRevision
    || ![c.trustedBinding, c.accountBinding, c.profileBinding, c.runBinding, c.model.providerID, c.model.modelID].every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096)
    || !['tenantId', 'projectId', 'sessionId', 'generation'].every(key => c.binding[key as keyof typeof c.binding] === request[key as keyof typeof c.binding])
    || !['queuedInputs', 'inputBytes', 'outputBytes', 'outputEvents', 'pendingInteractions', 'timeoutMs'].every(key => Number.isSafeInteger(c.limits[key as keyof Limits]) && c.limits[key as keyof Limits] > 0)
    || Object.keys(c.model).some(key => !['providerID', 'modelID'].includes(key))
    || [c.agent, c.variant].some(value => value !== undefined && (typeof value !== 'string' || !value || value.length > 4096))
    || typeof c.probe !== 'function' || typeof c.confirmStopped !== 'function') {throw new Error('opencode.v1.invalid-config')}
  const { capture: suppliedCapture, ...base } = c
  const capture = snapshotOpenCodeCapture(suppliedCapture)
  return { ...base, ...(capture ? { capture } : {}), ...(c.attachments !== undefined ? { attachments: snapshotAttachmentPort(c.attachments)! } : {}), binding: { ...c.binding }, limits: { ...c.limits }, model: { providerID: c.model.providerID, modelID: c.model.modelID } }
}
