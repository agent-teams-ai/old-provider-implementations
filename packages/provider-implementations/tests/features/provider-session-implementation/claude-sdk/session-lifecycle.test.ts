import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { Event } from '@agent-teams/provider-session-contracts';
import { createClaudeDriverFactory } from '../../../../src/claude.ts';
import type { ClaudeConfig, ClaudeSdkBoundary } from '../../../../src/claude.ts';
import { configuration, QueryFixture, request } from './support.ts';
import { ClaudeCapture } from '../../../../src/features/provider-session-implementation/adapters/claude-sdk/capture.ts';
import { compatibility } from '../../../../src/features/provider-session-implementation/adapters/claude-sdk/config.ts';

function deferred<T>() {
  let complete!: (value: T) => void;
  const promise = new Promise<T>(resolve => { complete = resolve; });
  return { promise, resolve: complete };
}
/** SDK EOF/close/Query.return retire the original root while one owned helper survives. */
function sdkFixture() {
  const base = new QueryFixture(), events: string[] = [];
  let rootLive = true, helperLive = true, eof = false, closes = 0, returns = 0;
  let closeThrows = false, holdRead = false;
  const retire = (reason: string) => { events.push(reason); rootLive = false; };
  let pump!: Promise<void>;
  const sdk: ClaudeSdkBoundary = {
    sessionExists: async () => true,
    query: args => {
      base.options = args.options;
      pump = (async () => {
        for await (const input of args.prompt) { base.inputs.push(input); }
        eof = true; retire('SDK-input-EOF');
      })();
      return {
        mcpServerStatus: () => base.mcpServerStatus(), interrupt: () => base.interrupt(),
        close() { closes++; retire('SDK-close'); if (!holdRead) { base.close(); } if (closeThrows) { throw new Error('TEST-private-close'); } },
        [Symbol.asyncIterator]() {
          const source = base[Symbol.asyncIterator]();
          return {
            next: () => source.next(),
            async return() { returns++; retire('SDK-Query.return'); return source.return(null); },
          };
        },
      };
    },
  };
  return { base, sdk, events, get rootLive() { return rootLive; }, get helperLive() { return helperLive; },
    get eof() { return eof; }, get closes() { return closes; }, get returns() { return returns; },
    ownerStops() { events.push('owner-stopped-group'); rootLive = false; helperLive = false; },
    throwOnClose() { closeThrows = true; }, holdReadOnClose() { holdRead = true; }, finishInput: () => pump };
}
async function open(f: ReturnType<typeof sdkFixture>, stop: () => Promise<boolean>, extra: Partial<Pick<ClaudeConfig, 'observeClose' | 'capture'>> = {}, timeoutMs?: number) {
  const c = { ...configuration(), ...extra }; if (timeoutMs !== undefined) { c.limits = { ...c.limits, timeoutMs }; } c.custody.confirmStopped = stop;
  return createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => c,
    readCheckpoint: async () => { throw new Error('no restore'); } }, f.sdk).open(request);
}

test('normal close holds SDK input and query teardown until the original group owner finishes', async () => {
  const f = sdkFixture(), entered = deferred<void>(), cleanup = deferred<boolean>(); let calls = 0;
  let rootAtOwner = false;
  const opened = await open(f, async () => {
    calls++; rootAtOwner = f.rootLive; entered.resolve();
    const clean = await cleanup.promise;
    if (clean && rootAtOwner) { f.ownerStops(); }
    return clean && rootAtOwner;
  });
  const closing = opened.driver.close();
  assert.equal(opened.driver.close(), closing, 'one cached close and original custody budget');
  await entered.promise;
  try {
    assert.equal(rootAtOwner, true, 'SDK must not retire root before caller-owned group cleanup');
    assert.equal(f.eof, false); assert.equal(f.closes, 0);
    assert.equal((await opened.driver.submit({ inputId: 'late', operationRef: 'late', content: 'TEST' })).ok, false);
  } finally { cleanup.resolve(true); await closing; }
  assert.equal((await closing).cleanup, 'confirmed'); await f.finishInput();
  assert.equal(calls, 1); assert.equal(f.helperLive, false); assert.equal(f.closes, 1); assert.equal(f.eof, true);
  assert.ok(f.events.indexOf('owner-stopped-group') < f.events.indexOf('SDK-close'));
});

test('late SDK output while owner close is pending cannot invoke Query.return and reap its root', async () => {
  const f = sdkFixture(), entered = deferred<void>(), cleanup = deferred<boolean>();
  const opened = await open(f, async () => { entered.resolve(); const clean = await cleanup.promise; if (clean) { f.ownerStops(); } return clean; });
  const closing = opened.driver.close(); await entered.promise;
  try {
    f.base.emit({ type: 'system', subtype: 'status', session_id: f.base.options.sessionId });
    await setImmediate();
    assert.equal(f.rootLive, true, 'late closed-state read must leave SDK teardown to the owner');
    assert.equal(f.returns, 0); assert.equal(f.closes, 0);
  } finally { cleanup.resolve(true); await closing; }
  assert.equal((await closing).cleanup, 'confirmed'); await f.finishInput();
});

test('false or throwing owner cleanup always releases SDK resources but never confirms custody', async () => {
  for (const mode of ['false', 'throw', 'SDK-close-throw'] as const) {
    const f = sdkFixture(); let calls = 0;
    if (mode === 'SDK-close-throw') { f.throwOnClose(); }
    const opened = await open(f, async () => {
      calls++; assert.equal(f.rootLive, true);
      if (mode === 'throw') { throw new Error('TEST-private-custody'); }
      if (mode === 'SDK-close-throw') { f.ownerStops(); return true; }
      return false;
    });
    const closing = opened.driver.close();
    assert.deepEqual(await closing, { logicallyClosed: true, cleanup: 'unknown' });
    assert.equal(await opened.driver.close(), await closing); await f.finishInput();
    assert.equal(calls, 1); assert.equal(f.closes, 1); assert.equal(f.eof, true);
  }
});

test('close denies pending native permission and preserves one unknown accepted input without another handoff', async () => {
  const f = sdkFixture(), entered = deferred<void>(), cleanup = deferred<boolean>();
  const opened = await open(f, async () => { entered.resolve(); await cleanup.promise; f.ownerStops(); return true; });
  const events: Event[] = [];
  const observing = (async () => { for await (const event of opened.driver.observe()) { events.push(event); } })();
  assert.equal((await opened.driver.submit({ inputId: 'active', operationRef: 'active-op', content: 'TEST' })).ok, true);
  const canUseTool = f.base.options.canUseTool; assert.ok(canUseTool);
  const permission = canUseTool('Read', { file_path: '/TEST-unused/file' }, { signal: new AbortController().signal, toolUseID: 'TEST-permission', requestId: 'TEST-request' });
  const closing = opened.driver.close(); await entered.promise;
  try {
    const decision = await permission; assert.ok(decision); assert.equal(decision.behavior, 'deny');
    assert.equal(f.rootLive, true); assert.equal(f.eof, false);
  } finally { cleanup.resolve(true); await closing; await observing; }
  assert.equal(f.base.inputs.length, 1);
  assert.equal(events.filter(event => event.kind === 'result' && event.inputId === 'active' && event.outcome === 'unknown').length, 1);
  assert.equal((await closing).cleanup, 'confirmed');
});


type CloseObservation = Parameters<NonNullable<ClaudeConfig['observeClose']>>[0];
test('private close stages distinguish physical custody from SDK/capture failures without changing receipts', async t => {
  for (const mode of ['confirmed', 'unconfirmed', 'custody-error', 'sdk-close-error', 'sdk-read-error', 'capture-close-error'] as const) {
    await t.test(mode, async child => {
      const f = sdkFixture(), seen: CloseObservation[] = [];
      if (mode === 'sdk-close-error') { f.throwOnClose(); }
      if (mode === 'sdk-read-error') { f.holdReadOnClose(); }
      if (mode === 'capture-close-error') {
        let calls = 0;
        child.mock.method(ClaudeCapture.prototype, 'close', async () => {
          if (++calls > 1) { throw new Error('TEST-private-capture'); }
        });
      }
      const opened = await open(f, async () => {
        if (mode === 'custody-error') { throw new Error('TEST-private-custody'); }
        if (mode === 'unconfirmed') { return false; }
        f.ownerStops(); return true;
      }, { observeClose: observation => { assert.equal(Object.isFrozen(observation), true); seen.push(observation); },
        ...(mode === 'capture-close-error' ? { capture: { observe: async () => {}, observeBackground: async () => {} } } : {}) }, 20);
      const closing = opened.driver.close();
      try {
        assert.deepEqual(await closing, { logicallyClosed: true, cleanup: mode === 'confirmed' ? 'confirmed' : 'unknown' });
        assert.equal(opened.driver.close(), closing);
        const expected: CloseObservation[] = [{ stage: 'custody', outcome: mode === 'unconfirmed' ? 'unconfirmed' : mode === 'custody-error' ? 'error' : 'confirmed' },
          { stage: 'sdk-close', outcome: mode === 'sdk-close-error' ? 'error' : 'completed' }];
        if (mode !== 'sdk-close-error') { expected.push({ stage: 'sdk-read', outcome: mode === 'sdk-read-error' ? 'error' : 'completed' }); }
        if (mode === 'capture-close-error') { expected.push({ stage: 'capture-close', outcome: 'error' }); }
        assert.deepEqual(seen, expected);
        assert.equal(JSON.stringify(seen).includes('TEST-private'), false);
      } finally { f.base.close(); await f.finishInput(); child.mock.restoreAll(); }
    });
  }
});

test('throwing, rejecting or never-settling private observers cannot affect cleanup or its cached order', { timeout: 2000 }, async () => {
  for (const mode of ['throw', 'reject', 'pending'] as const) {
    const f = sdkFixture(), seen: CloseObservation[] = [];
    const opened = await open(f, async () => { f.ownerStops(); return true; }, {
      observeClose: observation => {
        seen.push(observation);
        if (mode === 'throw') { throw new Error('TEST-private-observer'); }
        if (mode === 'reject') { return Promise.reject(new Error('TEST-private-observer')); }
        return new Promise<void>(() => {});
      },
    });
    const closing = opened.driver.close();
    assert.equal(opened.driver.close(), closing);
    assert.deepEqual(await closing, { logicallyClosed: true, cleanup: 'confirmed' });
    await setImmediate(); await f.finishInput();
    assert.deepEqual(seen.map(value => value.stage), ['custody', 'sdk-close', 'sdk-read']);
    assert.ok(f.events.indexOf('owner-stopped-group') < f.events.indexOf('SDK-close'));
    assert.equal(f.closes, 1);
  }
});

test('private observer selection is validated and excluded from native checkpoint compatibility', async () => {
  const base = configuration(), observed = { ...base, observeClose: async () => {} };
  assert.equal(compatibility(base), compatibility(observed));
  const f = sdkFixture();
  await assert.rejects(() => open(f, async () => true, { observeClose: 'TEST-invalid' as never }), /invalid-config/u);
  assert.equal(f.base.calls, 0);
});

function idleSuccess(sessionId: string) {
  return { type: 'result', subtype: 'success', is_error: false, session_id: sessionId,
    uuid: 'TEST-background-result', result: 'TEST background acknowledgment', stop_reason: 'end_turn',
    duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0,
    usage: {}, modelUsage: {}, permission_denials: [] };
}

test('successful native idle notification acknowledgment preserves the next independent input without a fabricated foreground result', async () => {
  const f = sdkFixture(), events: Event[] = [], completed = deferred<void>();
  const opened = await open(f, async () => { f.ownerStops(); return true; });
  const observing = (async () => {
    for await (const event of opened.driver.observe()) {
      events.push(event);
      if (event.kind === 'result' && event.inputId === 'TEST-original') { completed.resolve(); }
    }
  })();
  try {
    assert.equal((await opened.driver.submit({ inputId: 'TEST-original', operationRef: 'TEST-original-op', content: 'TEST original input' })).ok, true);
    await setImmediate();
    const original = f.base.inputs[0]!;
    assert.ok(original.session_id);
    f.base.emit({ ...idleSuccess(original.session_id), user_message_uuid: original.uuid });
    await completed.promise;
    f.base.emit({ type: 'assistant', session_id: original.session_id, parent_tool_use_id: null,
      message: { id: 'TEST-background-ack', role: 'assistant', content: [{ type: 'text', text: 'TEST background acknowledgment' }] } });
    f.base.emit(idleSuccess(original.session_id));
    await setImmediate();
    assert.equal(events.filter(event => event.kind === 'result').length, 1,
      'unowned acknowledgment never becomes an invented foreground result');
    const next = { inputId: 'TEST-next', operationRef: 'TEST-next-op', content: 'TEST independent next input' };
    assert.equal((await opened.driver.submit(next)).ok, true);
    await setImmediate();
    assert.equal(f.base.inputs.length, 2);
    const nativeNext = f.base.inputs[1]!;
    assert.ok(nativeNext.session_id);
    assert.equal(nativeNext.message.content, next.content);
    assert.notEqual(nativeNext.uuid, original.uuid);
    f.base.emit({ ...idleSuccess(nativeNext.session_id), user_message_uuid: nativeNext.uuid });
    await setImmediate();
    assert.deepEqual(events.filter(event => event.kind === 'result').map(event => ({ inputId: event.inputId, outcome: event.kind === 'result' ? event.outcome : undefined })),
      [{ inputId: 'TEST-original', outcome: 'succeeded' }, { inputId: 'TEST-next', outcome: 'succeeded' }]);
  } finally { await opened.driver.close(); await observing; await f.finishInput(); }
});

test('missing or foreign session, malformed or failed idle result, and active unattributed result cannot grant another input', async () => {
  for (const mode of ['missing-session', 'foreign-session', 'malformed', 'failed', 'resume', 'stale-echo', 'active-unattributed'] as const) {
    const f = sdkFixture(), completed = deferred<void>(), events: Event[] = [];
    const opened = await open(f, async () => { f.ownerStops(); return true; });
    const observing = (async () => { for await (const event of opened.driver.observe()) {
      events.push(event); if (event.kind === 'result' && event.inputId === 'TEST-original') { completed.resolve(); }
    } })();
    try {
      assert.equal((await opened.driver.submit({ inputId: 'TEST-original', operationRef: 'TEST-original-op', content: 'TEST original input' })).ok, true);
      await setImmediate();
      const original = f.base.inputs[0]!;
      assert.ok(original.session_id);
      if (mode !== 'active-unattributed') {
        f.base.emit({ ...idleSuccess(original.session_id), user_message_uuid: original.uuid });
        await completed.promise;
      }
      const invalid: Record<string, unknown> = idleSuccess(original.session_id);
      if (mode === 'missing-session') { delete invalid.session_id; }
      if (mode === 'foreign-session') { invalid.session_id = 'TEST-foreign-session'; }
      if (mode === 'malformed') { delete invalid.result; }
      if (mode === 'failed') { invalid.is_error = true; }
      if (mode === 'resume') { invalid.resume_reason = 'TEST-resume'; }
      if (mode === 'stale-echo') { invalid.user_message_uuid = original.uuid; }
      f.base.emit(invalid); await setImmediate();
      assert.equal((await opened.driver.submit({ inputId: 'TEST-forbidden-next', operationRef: 'TEST-forbidden-op', content: 'TEST must not reach query' })).ok, false, mode);
      assert.equal(f.base.inputs.length, 1, mode);
      if (mode === 'active-unattributed') {
        assert.equal(events.filter(event => event.kind === 'result' && event.inputId === 'TEST-original' && event.outcome === 'unknown').length, 1);
      }
    } finally { await opened.driver.close(); await observing; await f.finishInput(); }
  }
});
