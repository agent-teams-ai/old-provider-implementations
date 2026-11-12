import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOpenCodeV2ExecutionTransport, wasOpenCodeV2InputNotSubmitted } from '../../../../src/opencode.ts'
import { createV2ControlWire } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-control-transport.ts'
import { ExecutionTransportFailure } from '../../../../src/features/provider-session-implementation/adapters/opencode-protocol/v2-failures.ts'
import type { OpenCodeV2TransportConfig } from '../../../../src/opencode.ts'

type Admission = NonNullable<OpenCodeV2TransportConfig['beforeRequest']>
const endpoint = 'http://127.0.0.1:12345'
for (const kind of ['execution', 'control'] as const) {
  const setup = (beforeRequest: Admission, extra: Partial<OpenCodeV2TransportConfig> = {}) => {
    const counts = { credentials: 0, fetches: 0 }
    const config: OpenCodeV2TransportConfig = {
      endpoint, version: '2.0.21', directory: '/TEST/original', nativeSessionId: 'ses_A',
      deadline: Date.now() + 10_000, beforeRequest,
      readPassword: () => { counts.credentials++; return 'TEST-private' },
      fetchImpl: async () => {
        counts.fetches++
        return new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } })
      },
      ...extra,
    }
    const source = kind === 'execution' ? createOpenCodeV2ExecutionTransport(config) : createV2ControlWire(config)
    return { counts, config, dispose: () => source.dispose(),
      request: () => 'fetch' in source ? source.fetch(endpoint + '/api/session/ses_A')
        : source.request('/api/session/ses_A/permission') }
  }

  test(`${kind}: native credentials wait for original Host admission callback`, async () => {
    const entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void | (() => void)>()
    let releases = 0, replacementCalls = 0
    const wire = setup(async () => { entered.resolve(); return ready.promise })
    wire.config.beforeRequest = async () => { replacementCalls++ }
    const pending = wire.request()
    await entered.promise
    assert.deepEqual(wire.counts, { credentials: 0, fetches: 0 })
    ready.resolve(() => { releases++ })
    assert.equal((await pending).status, 200)
    assert.deepEqual(wire.counts, { credentials: 1, fetches: 1 })
    assert.equal(replacementCalls, 0)
    assert.equal(releases, 1)
    await wire.dispose()
    assert.equal(releases, 1)
  })

  test(`${kind}: admission lease remains held through native response body`, async () => {
    const fetched = Promise.withResolvers<void>()
    let body!: ReadableStreamDefaultController<Uint8Array>, releases = 0
    const wire = setup(async () => () => { releases++ }, {
      fetchImpl: async () => {
        fetched.resolve()
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller } }),
          { headers: { 'content-type': 'application/json' } })
      },
    })
    const pending = wire.request()
    await fetched.promise
    assert.equal(releases, 0)
    body.enqueue(new TextEncoder().encode('{"data":[]}'))
    body.close()
    await pending
    assert.equal(releases, 1)
    await wire.dispose()
  })

  test(`${kind}: revoked pending admission never reads credentials and releases late lease`, async () => {
    const entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void | (() => void)>()
    const revoked = new AbortController()
    let releases = 0
    const wire = setup(async signal => {
      assert.equal(signal.aborted, false)
      entered.resolve()
      return ready.promise
    }, { signal: revoked.signal })
    const pending = wire.request()
    await entered.promise
    revoked.abort()
    await assert.rejects(pending, error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
      assert.equal((error as ExecutionTransportFailure).code, 'cleanup_unknown')
      return true
    })
    assert.deepEqual(wire.counts, { credentials: 0, fetches: 0 })
    ready.resolve(() => { releases++ })
    await wire.dispose()
    assert.equal(releases, 1)
  })

  test(`${kind}: admission refusal is sanitized before native effects`, async () => {
    const wire = setup(async () => { throw Error('TEST-private-reason-must-not-escape') })
    await assert.rejects(wire.request(), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), true)
      assert.equal((error as Error).message, 'transport_failure')
      return true
    })
    assert.deepEqual(wire.counts, { credentials: 0, fetches: 0 })
    await wire.dispose()
  })

  test(`${kind}: Host UNKNOWN cannot become safe-to-retry admission refusal`, async () => {
    const wire = setup(async () => { throw new ExecutionTransportFailure('native_prompt_unknown', 'unknown') })
    await assert.rejects(wire.request(), error => {
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
      assert.equal((error as ExecutionTransportFailure).disposition, 'unknown')
      return true
    })
    assert.deepEqual(wire.counts, { credentials: 0, fetches: 0 })
    await wire.dispose()
  })

  test(`${kind}: failed admission release cannot certify clean native completion`, async () => {
    let releases = 0
    const wire = setup(async () => () => { releases++; throw Error('TEST-private-release') })
    await assert.rejects(wire.request(), error => {
      assert.equal((error as ExecutionTransportFailure).code, 'cleanup_unknown')
      assert.equal(wasOpenCodeV2InputNotSubmitted(error), false)
      return true
    })
    assert.equal(releases, 1)
    await wire.dispose()
    assert.equal(releases, 1)
  })
}
