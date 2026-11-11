import { createV2OwnerTransport } from './v2-execution-transport.ts'
import type { OpenCodeV2TransportConfig } from './v2-execution-transport.ts'
import { createOpenCodeV2SessionControl } from './v2-session-control.ts'
import { decodeV2DataEnvelope, decodeV2Session } from './v2-cut-codecs.ts'
import { record } from './v2-projection-helpers.ts'
import { executionAssert } from './v2-failures.ts'

export type OpenCodeV2SessionPermissionRule = Readonly<{
  action: string; resource: string; effect: 'allow' | 'ask' | 'deny'
}>
export type OpenCodeV2OwnedSessionSelection = Readonly<{
  agent: string
  model: Readonly<{ providerID: string; id: string; variant?: string }>
  permissions: readonly OpenCodeV2SessionPermissionRule[]
}>
function text(value: unknown): asserts value is string {
  executionAssert(typeof value === 'string' && value.length > 0 && value.length <= 4096, 'invalid_native_identity')
}
function rules(value: unknown): OpenCodeV2SessionPermissionRule[] {
  executionAssert(Array.isArray(value) && value.length > 0 && value.length <= 4096, 'invalid_native_permissions')
  return value.map(item => {
    const rule = record(item)
    executionAssert(rule !== null && Object.keys(rule).toSorted().join(',') === 'action,effect,resource', 'invalid_native_permissions')
    text(rule.action); text(rule.resource)
    executionAssert(rule.effect === 'allow' || rule.effect === 'ask' || rule.effect === 'deny', 'invalid_native_permissions')
    return { action: rule.action, resource: rule.resource, effect: rule.effect as OpenCodeV2SessionPermissionRule['effect'] }
  })
}
function selection(value: unknown, captureDefault = false): OpenCodeV2OwnedSessionSelection {
  const selected = record(value), model = record(selected?.model)
  executionAssert(selected !== null && model !== null, 'invalid_native_identity')
  text(selected.agent); text(model.providerID); text(model.id)
  if (model.variant !== undefined) text(model.variant)
  const variant = model.variant === undefined && captureDefault ? 'default' : model.variant
  return { agent: selected.agent,
    // Exact 2.1.4 canonical model variant; capture it before create effects,
    // then require the same readback rather than accepting an arbitrary default.
    model: { providerID: model.providerID, id: model.id, ...(variant === undefined ? {} : { variant: variant as string }) },
    permissions: rules(selected.permissions) }
}

/** Finite native protocol operations for an already-owned 2.1.4 child.
 * Host owns durable create intent, process custody, saved policy and cleanup.
 * This client cannot spawn a child, submit a prompt or adopt another session.
 */
export function createOpenCodeV2OwnedSessionClient(supplied: OpenCodeV2TransportConfig) {
  const config = { ...supplied }
  executionAssert(config.version === '2.1.4', 'unqualified_version')
  const wire = createV2OwnerTransport(config), control = createOpenCodeV2SessionControl(config)
  let createAttempted = false
  const session = (value: unknown) => {
    const decoded = decodeV2Session(value, config.nativeSessionId, config.directory)
    const raw = record(decodeV2DataEnvelope(value))
    const picked = selection(raw)
    return { id: decoded.id, directory: decoded.directory, ...picked }
  }
  return {
    async identity(): Promise<Readonly<{ pid: number; version: '2.1.4' }>> {
      const value = record(await (await wire.fetch(config.endpoint + '/api/info')).json() as unknown)
      executionAssert(value !== null && value.version === config.version && Number.isSafeInteger(value.pid) && Number(value.pid) > 0,
        'native_identity_mismatch')
      return { pid: Number(value.pid), version: '2.1.4' }
    },
    async createSession(input: OpenCodeV2OwnedSessionSelection) {
      const captured = selection(structuredClone(input), true)
      executionAssert(!createAttempted, 'native_create_already_attempted')
      // Native session.create supports a caller-chosen id. Its durable owner
      // captures this exact identity before effects; a lost ACK is never retried.
      createAttempted = true
      const created = session(await (await wire.fetch(config.endpoint + '/api/session', {
        method: 'POST', body: JSON.stringify({ id: config.nativeSessionId,
          location: { directory: config.directory }, ...captured }),
      })).json() as unknown)
      executionAssert(JSON.stringify(selection(created)) === JSON.stringify(captured), 'native_selection_mismatch')
      return created
    },
    async readSession() {
      return session(await (await wire.fetch(config.endpoint + `/api/session/${config.nativeSessionId}`)).json() as unknown)
    },
    /** Isolated owner database only. Never exports saved grant details or mutates them. */
    async savedPermissionsEmpty(): Promise<boolean> {
      const value = decodeV2DataEnvelope(await (await wire.fetch(config.endpoint + '/api/permission/saved')).json() as unknown)
      executionAssert(Array.isArray(value) && value.length <= 4096, 'invalid_native_saved_permissions')
      return value.length === 0
    },
    async readMcp(): Promise<readonly Readonly<{ name: string; status: string }>[]> {
      const query = new URLSearchParams({ 'location[directory]': config.directory })
      const value = record(await (await wire.fetch(config.endpoint + `/api/mcp?${query}`)).json() as unknown)
      executionAssert(value !== null && record(value.location)?.directory === config.directory &&
        Array.isArray(value.data) && value.data.length <= 256, 'native_mcp_binding_mismatch')
      const rows = (value.data as unknown[]).map(item => {
        const row = record(item), status = record(row?.status)
        executionAssert(row !== null && status !== null, 'invalid_native_mcp')
        text(row.name)
        executionAssert(typeof status.status === 'string' && ['connected', 'pending', 'disabled', 'failed', 'needs_auth'].includes(status.status), 'invalid_native_mcp')
        return { name: row.name, status: status.status as string }
      })
      executionAssert(new Set(rows.map(row => row.name)).size === rows.length, 'invalid_native_mcp')
      return rows
    },
    putInstruction: control.putInstruction,
    instructions: control.instructions,
    async dispose() {
      const outcomes = await Promise.allSettled([wire.dispose(), control.dispose()])
      const failed = outcomes.find(row => row.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    },
  }
}
