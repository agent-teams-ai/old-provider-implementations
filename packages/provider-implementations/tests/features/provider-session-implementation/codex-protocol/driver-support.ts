import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import type { TestContext } from 'node:test'
import type { Event, OpenConfig } from '@agent-teams/provider-session-contracts'
import { createCodexDriverFactory } from '../../../../src/codex.ts'
import type { CodexDriverConfig, CodexDriverHost } from '../../../../src/codex.ts'
import { fixture } from './subprocess-fixture.ts'

export const selection = (sessionId = 'runtime-A'): OpenConfig => ({ tenantId: 'tenant', projectId: 'project', sessionId, generation: 1,
  configRevision: 'config-1', requiredCapabilities: ['text', 'tools', 'permission', 'interrupt', 'checkpoint'] })
export const input = (n = 1) => ({ inputId: `input-${n}`, operationRef: `op-${n}`, content: `message ${n}` })
export const capabilities = ['text', 'tools', 'usage', 'permission', 'interrupt', 'checkpoint']
export async function context(t: TestContext, sessionId = 'runtime-A') {
  const native = await fixture(t)
  const request = selection(sessionId)
  const config: CodexDriverConfig = { binding: { tenantId: request.tenantId, projectId: request.projectId, sessionId, generation: request.generation },
    configRevision: request.configRevision, protocolRevision: 'TEST-native-v1', accountBinding: 'TEST-account', trustedBinding: 'TEST-binding',
    transport: native.transport, initialize: { clientInfo: { name: 'isolated-runtime', version: '0.0.0' } },
    threadParams: { cwd: '/TEST-disposable', model: 'TEST-model', approvalPolicy: 'on-request', sandbox: 'read-only' },
    limits: { queuedInputs: 1, inputBytes: 4096, outputBytes: 8192, outputEvents: 50, pendingInteractions: 2, timeoutMs: 2000 },
    probe: async () => true, confirmStopped: async () => false }
  let checkpoint: unknown
  const host: CodexDriverHost = { capabilities, resolveConfiguration: async () => config, readCheckpoint: async () => checkpoint }
  const factory = createCodexDriverFactory(host)
  return { native, request, config, host, factory, checkpoint(value: unknown) { checkpoint = value } }
}
export async function opened(t: TestContext, sessionId = 'runtime-A') {
  const test = await context(t, sessionId)
  const { driver } = await test.factory.open(test.request)
  t.after(() => driver.close())
  const events: Event[] = []
  const observing = (async () => { for await (const event of driver.observe()) {events.push(event)} })()
  t.after(async () => { await driver.close(); await observing })
  return { ...test, driver, events }
}
export async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2500
  while (!predicate() && Date.now() < deadline) {await setImmediate()}
  assert(predicate(), 'expected scoped canonical observation')
}
export function ref(native: Awaited<ReturnType<typeof fixture>>, turnId = 'turn-1') {
  const params = native.writes.findLast(frame => frame.method === 'turn/start')?.params as Record<string, unknown>
  assert.equal(typeof params?.threadId, 'string')
  return { threadId: params.threadId as string, turnId }
}
