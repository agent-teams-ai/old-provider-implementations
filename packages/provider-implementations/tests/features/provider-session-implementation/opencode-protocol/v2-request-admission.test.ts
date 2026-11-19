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

  for (const mode of ['return', 'reject', 'unknown', 'cleanup-unknown', 'cleanup-code', 'release-failure', 'at-cutoff'] as const) {
    test(`${kind}: cooperative cancelled admission preserves ${mode}`, async t => {
      const entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void | (() => void)>()
      const revoked = new AbortController()
      let calls = 0, aborted = 0, releases = 0, now = Date.now()
      if (mode === 'at-cutoff') t.mock.method(Date, 'now', () => now)
      const release = () => {
        releases++
        if (mode === 'release-failure') throw Error('TEST-private-release')
      }
      const wire = setup(async signal => {
        calls++
        assert.equal(signal.aborted, false)
        signal.addEventListener('abort', () => {
          aborted++
          if (mode === 'at-cutoff') now += 10_000
          if (mode === 'reject') ready.reject(Error('TEST-private-admission'))
          else if (mode === 'unknown') ready.reject(new ExecutionTransportFailure('native_prompt_unknown', 'unknown'))
          else if (mode === 'cleanup-unknown') ready.reject(new ExecutionTransportFailure('cleanup_unknown', 'unknown'))
          else if (mode === 'cleanup-code') ready.reject(new ExecutionTransportFailure('cleanup_unknown', 'not_submitted'))
          else ready.resolve(release)
        }, { once: true })
        entered.resolve()
        return ready.promise
      }, { signal: revoked.signal })
      const pending = wire.request().then(() => ({ ok: true as const }), error => ({ ok: false as const, error: error as unknown }))
      t.after(async () => { revoked.abort(); ready.resolve(release); await pending; await wire.dispose() })
      await entered.promise
      revoked.abort()
      const outcome = await pending
      // Join the same tracked callback even when checking the old early-failure implementation.
      await wire.dispose()
      assert.equal(outcome.ok, false)
      if (outcome.ok) assert.fail('Cancelled admission cannot dispatch a native request')
      const unknown = !['return', 'reject'].includes(mode)
      assert.equal(wasOpenCodeV2InputNotSubmitted(outcome.error), !unknown)
      assert.ok(outcome.error instanceof ExecutionTransportFailure)
      assert.equal(outcome.error.code, mode === 'unknown' ? 'native_prompt_unknown' : unknown ? 'cleanup_unknown' : 'transport_failure')
      assert.deepEqual({ calls, aborted, releases }, { calls: 1, aborted: 1,
        releases: ['return', 'release-failure', 'at-cutoff'].includes(mode) ? 1 : 0 })
      assert.deepEqual(wire.counts, { credentials: 0, fetches: 0 })
      await wire.dispose()
      assert.equal(releases, ['return', 'release-failure', 'at-cutoff'].includes(mode) ? 1 : 0)
    })
  }

  for (const contextMs of [20_000, 60_000]) test(
    `${kind}: pending cancelled admission retains original request cutoff with context ${contextMs}`, async t => {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
      const entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void | (() => void)>()
      const revoked = new AbortController()
      let calls = 0, releases = 0, finished = false
      const release = () => { releases++ }
      const wire = setup(async () => { calls++; entered.resolve(); return ready.promise },
        { signal: revoked.signal, deadline: contextMs })
      const pending = wire.request().then(() => { finished = true; return { ok: true as const } },
        error => { finished = true; return { ok: false as const, error: error as unknown } })
      t.after(async () => { revoked.abort(); ready.resolve(release); await pending; await wire.dispose() })
      await entered.promise
      revoked.abort()
      await new Promise<void>(done => setImmediate(done))
      assert.equal(finished, false, 'The same original callback must get its remaining request bound')
      const requestMs = Math.min(30_000, contextMs)
      t.mock.timers.tick(requestMs - 1)
      await new Promise<void>(done => setImmediate(done))
      assert.equal(finished, false)
      t.mock.timers.tick(1)
      await new Promise<void>(done => setImmediate(done))
      assert.equal(Date.now(), requestMs)
      assert.equal(finished, true, 'The original request cutoff must win over a later context deadline')
      const outcome = await pending
      assert.equal(outcome.ok, false)
      if (outcome.ok) assert.fail('Unsettled admission cannot dispatch a native request')
      assert.ok(outcome.error instanceof ExecutionTransportFailure)
      assert.equal(outcome.error.code, 'cleanup_unknown')
      assert.equal(wasOpenCodeV2InputNotSubmitted(outcome.error), false)
      assert.deepEqual(wire.counts, { credentials: 0, fetches: 0 })
      ready.resolve(release)
      await wire.dispose()
      await wire.dispose()
      assert.deepEqual({ calls, releases }, { calls: 1, releases: 1 })
    }
  )
}
