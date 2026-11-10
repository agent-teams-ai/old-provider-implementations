import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate, setTimeout as wait } from 'node:timers/promises';
import type { HookCallback, PostToolUseFailureHookInput, PostToolUseHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { openClaudeSession } from '../../../../src/claude.ts';
import type { ClaudeCaptureRequest } from '../../../../src/claude.ts';
import { ClaudeCapture } from '../../../../src/features/provider-session-implementation/adapters/claude-sdk/capture.ts';
import { configuration, QueryFixture } from './support.ts';

function deferred() { let finish!: () => void; return { promise: new Promise<void>(resolve => { finish = resolve; }), resolve: () => finish() }; }
async function fixture(observe: (request: ClaudeCaptureRequest) => Promise<void>, timeoutMs = 300, confirmStopped = async () => true) {
  const sdk = new QueryFixture(), config = configuration();
  config.nativeTools = ['Bash', 'Read']; config.capture = { observe }; config.limits = { ...config.limits, timeoutMs };
  config.custody = { ...config.custody, confirmStopped };
  const opened = await openClaudeSession(config, undefined, sdk.boundary); assert.ok(opened.ok);
  const session = opened.value;
  const hook = (phase: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'): HookCallback => {
    const callback = sdk.options.hooks?.[phase]?.[0]?.hooks[0]; assert.ok(callback); return callback;
  };
  const pre = (id = 'tool-A'): PreToolUseHookInput => ({ hook_event_name: 'PreToolUse',
    session_id: sdk.options.sessionId!, transcript_path: '/TEST-unused/transcript', cwd: config.cwd,
    tool_name: 'Bash', tool_use_id: id, tool_input: { command: 'TEST native effect' } });
  const post = (id = 'tool-A'): PostToolUseHookInput => ({ ...pre(id), hook_event_name: 'PostToolUse', tool_response: { status: 'ok' } });
  const failed = (id = 'tool-A'): PostToolUseFailureHookInput => ({ ...pre(id), hook_event_name: 'PostToolUseFailure', error: 'private native stderr' });
  const start = async (name: string) => {
    assert.ok((await session.submit({ inputId: `input-${name}`, operationRef: `operation-${name}`, content: `TEST ${name}` })).ok);
    await setImmediate();
    sdk.emit({ type: 'assistant', parent_tool_use_id: null, user_message_uuid: sdk.inputs.at(-1)?.uuid,
      message: { id: `message-${name}`, content: [{ type: 'tool_use', id: `tool-${name}`, name: 'Bash', input: { command: 'TEST native effect' } }] } });
    await setImmediate();
  };
  const terminal = async () => {
    sdk.emit({ type: 'result', subtype: 'success', session_id: sdk.options.sessionId, user_message_uuid: sdk.inputs.at(-1)?.uuid }); await setImmediate();
  };
  return { sdk, config, session, hook, pre, post, failed, start, terminal };
}
const invoke = (hook: HookCallback, input: PreToolUseHookInput | PostToolUseHookInput | PostToolUseFailureHookInput,
  id: string | undefined = input.tool_use_id) => hook(input, id, { signal: new AbortController().signal });

test('SDK hook awaits copied preimage observation before its caller can execute; duplicate joins the same callback', async () => {
  const pending = deferred(), observations: ClaudeCaptureRequest[] = [];
  const f = await fixture(async request => { observations.push(request); if (request.phase === 'before') {await pending.promise;} });
  try {
    await f.start('A'); let effects = 0;
    const original = f.pre();
    const run = async () => { const result = await invoke(f.hook('PreToolUse'), original); assert.deepEqual(result, {}); effects++; };
    const first = run(), duplicate = run();
    (original.tool_input as { command: string }).command = 'mutated after capture';
    await setImmediate(); assert.equal(effects, 0); assert.equal(observations.length, 1);
    const before = observations[0]!; assert.equal(before.phase, 'before'); assert.ok(Object.isFrozen(before));
    assert.equal(before.inputId, 'input-A'); assert.equal(before.operationRef, 'operation-A');
    if (before.phase === 'before') {assert.deepEqual(before.toolInput, { command: 'TEST native effect' });}
    pending.resolve(); await Promise.all([first, duplicate]); assert.equal(effects, 2);
    assert.deepEqual(await invoke(f.hook('PostToolUseFailure'), f.failed()), {});
    const after = observations[1]!; assert.equal(after.phase, 'after');
    if (after.phase === 'after') {assert.equal(after.outcome, 'failed');}
    assert.equal('error' in after, false, 'raw native stderr never enters capture observations');
    await invoke(f.hook('PostToolUseFailure'), f.failed()); assert.equal(observations.length, 2);
  } finally { pending.resolve(); await f.session.close(); }
});

test('foreign session, child, unknown tool and mismatched callback ID cannot borrow a current input', async () => {
  const observations: ClaudeCaptureRequest[] = [];
  const f = await fixture(async request => { observations.push(request); });
  try {
    await f.start('A');
    for (const input of [{ ...f.pre(), session_id: 'foreign' }, { ...f.pre(), agent_id: 'child' }, { ...f.pre(), tool_name: 'UnknownTool' }])
      {assert.deepEqual(await invoke(f.hook('PreToolUse'), input), {});}
    assert.deepEqual(await invoke(f.hook('PreToolUse'), f.pre(), 'wrong-id'), {});
    await invoke(f.hook('PreToolUse'), f.pre('unobserved-tool'));
    assert.equal(observations.length, 1); const gap = observations[0]!;
    assert.equal(gap.phase, 'gap'); assert.equal(gap.inputId, undefined); assert.equal(gap.operationRef, undefined);
    assert.deepEqual(await f.session.checkReadiness(), { ok: true, value: undefined });
  } finally { await f.session.close(); }
});

test('a retained late A completion reports an A gap after B starts; it never publishes B bytes as A success', async () => {
  const observations: ClaudeCaptureRequest[] = [];
  const f = await fixture(async request => { observations.push(request); });
  try {
    await f.start('A'); await invoke(f.hook('PreToolUse'), f.pre()); await f.terminal();
    await f.start('B');
    await invoke(f.hook('PostToolUse'), f.post());
    assert.deepEqual(observations.map(request => [request.phase, request.inputId]), [['before', 'input-A'], ['gap', 'input-A']]);
    await invoke(f.hook('PreToolUse'), f.pre('tool-B'));
    await invoke(f.hook('PostToolUse'), f.post('tool-B'));
    assert.deepEqual(observations.slice(2).map(request => [request.phase, request.inputId]), [['before', 'input-B'], ['after', 'input-B']]);
  } finally { await f.session.close(); }
});

test('ownership is rechecked after awaiting before and after, retaining the original input in gaps', async () => {
  for (const delayedPhase of ['before', 'after'] as const) {
    const pending = deferred(), observations: ClaudeCaptureRequest[] = [];
    const f = await fixture(async request => { observations.push(request); if (request.phase === delayedPhase) {await pending.promise;} });
    try {
      await f.start('A');
      const before = invoke(f.hook('PreToolUse'), f.pre());
      if (delayedPhase === 'after') {await before;}
      const running = delayedPhase === 'before' ? before : invoke(f.hook('PostToolUse'), f.post());
      await f.terminal(); await f.start('B'); pending.resolve(); assert.deepEqual(await running, {});
      const gap = observations.at(-1)!; assert.equal(gap.phase, 'gap'); assert.equal(gap.inputId, 'input-A');
      assert.equal(observations.some(request => request.inputId === 'input-B'), false);
    } finally { pending.resolve(); await f.session.close(); }
  }
});

test('capture errors and deadlines produce gaps without denying tools or changing permission configuration', async () => {
  for (const mode of ['reject', 'deadline'] as const) {
    const observations: ClaudeCaptureRequest[] = [], pending = deferred();
    const f = await fixture(async request => {
      observations.push(request);
      if (request.phase === 'before') { if (mode === 'reject') {throw new Error('private failure');} await pending.promise; }
    }, 20);
    try {
      await f.start('A'); assert.deepEqual(await invoke(f.hook('PreToolUse'), f.pre()), {});
      assert.deepEqual(observations.map(request => request.phase), ['before', 'gap']);
      assert.equal(observations[0]!.signal.aborted, mode === 'deadline');
      assert.equal(f.sdk.options.permissionMode, 'default'); assert.deepEqual(f.sdk.options.allowedTools, []);
      assert.deepEqual(await f.session.checkReadiness(), { ok: true, value: undefined });
      await invoke(f.hook('PostToolUse'), f.post()); assert.equal(observations.length, 2);
    } finally { pending.resolve(); await f.session.close(); }
  }
});

test('conflicting post input/outcome is a gap; completed records do not run capture twice', async () => {
  const observations: ClaudeCaptureRequest[] = [];
  const f = await fixture(async request => { observations.push(request); });
  try {
    await f.start('A'); await invoke(f.hook('PreToolUse'), f.pre());
    await invoke(f.hook('PostToolUse'), { ...f.post(), tool_input: { command: 'different effect' } });
    assert.deepEqual(observations.map(request => request.phase), ['before', 'gap']);
    await f.terminal(); await f.start('B');
    await invoke(f.hook('PreToolUse'), f.pre('tool-B')); await invoke(f.hook('PostToolUse'), f.post('tool-B'));
    await invoke(f.hook('PostToolUse'), f.post('tool-B')); await invoke(f.hook('PostToolUseFailure'), f.failed('tool-B'));
    assert.deepEqual(observations.slice(2).map(request => request.phase), ['before', 'after', 'gap']);
  } finally { await f.session.close(); }
});

test('close aborts outstanding capture and bounded gap cleanup never prevents physical custody confirmation', async () => {
  const pending = deferred(), observations: ClaudeCaptureRequest[] = [];
  let physicalChecks = 0;
  const f = await fixture(async request => { observations.push(request); await pending.promise; }, 20, async () => { physicalChecks++; return true; });
  // Config is snapshotted: replace neither custody nor the capture callback after opening.
  f.config.capture = { observe: async () => { throw new Error('must stay captured'); } };
  f.config.custody.confirmStopped = async () => { throw new Error('must stay captured'); };
  try {
    await f.start('A'); const running = invoke(f.hook('PreToolUse'), f.pre());
    const closed = await f.session.close(); assert.deepEqual(closed, { logicallyClosed: true, cleanup: 'confirmed' });
    assert.deepEqual(await running, {}); assert.ok(observations[0]!.signal.aborted);
    assert.deepEqual(observations.map(request => request.phase), ['before', 'gap']);
    assert.equal(physicalChecks, 1, 'the original snapshotted custody callback was used');
    await wait(1);
  } finally { pending.resolve(); await f.session.close(); }
});

test('interrupt aborts a waiting preimage without introducing capture authorization or restoring A callbacks', async () => {
  const pending = deferred(), observations: ClaudeCaptureRequest[] = [];
  const f = await fixture(async request => { observations.push(request); if (request.phase === 'before') {await pending.promise;} });
  try {
    await f.start('A'); const running = invoke(f.hook('PreToolUse'), f.pre());
    assert.ok((await f.session.interrupt('operation-A')).ok);
    assert.deepEqual(await running, {}); assert.ok(observations[0]!.signal.aborted);
    assert.deepEqual(observations.map(request => [request.phase, request.inputId]), [['before', 'input-A'], ['gap', 'input-A']]);
    pending.resolve(); await invoke(f.hook('PostToolUse'), f.post());
    assert.equal(observations.length, 2);
  } finally { pending.resolve(); await f.session.close(); }
});

test('retention never evicts completed native pairs; overflow reports one unbound gap and keeps tools usable', async () => {
  const observations: ClaudeCaptureRequest[] = [], revocation = new AbortController();
  const capture = new ClaudeCapture({ port: { observe: async request => { observations.push(request); } },
    sessionRef: 'session', nativeSession: 'native', names: ['Bash'], maxPairs: 1, maxBytes: 1024, timeoutMs: 30,
    currentOwner: () => ({ inputId: 'input', operationRef: 'operation', nativeRef: 'native-input', revoked: revocation.signal }) });
  const nativeSession = 'native';
  const pre = (id: string): PreToolUseHookInput => ({ hook_event_name: 'PreToolUse', session_id: nativeSession,
    transcript_path: '/TEST-unused/transcript', cwd: '/TEST-unused', tool_name: 'Bash', tool_use_id: id, tool_input: {} });
  try {
    await invoke(capture.hook, pre('first'));
    await invoke(capture.hook, { ...pre('first'), hook_event_name: 'PostToolUse', tool_response: {} });
    for (let index = 0; index < 20; index++) {assert.deepEqual(await invoke(capture.hook, pre(`later-${index}`)), {});}
    assert.deepEqual(observations.map(request => request.phase), ['before', 'after', 'gap']);
    const gap = observations[2]!; assert.equal(gap.inputId, undefined);
    if (gap.phase === 'gap') {assert.equal(gap.reason, 'limit');}
    await invoke(capture.hook, { ...pre('first'), hook_event_name: 'PostToolUse', tool_response: {} });
    assert.equal(observations.length, 3);
  } finally { await capture.close(); }
});

test('oversized tool input creates only a gap, never retained partial input or later success', async () => {
  const observations: ClaudeCaptureRequest[] = [];
  const f = await fixture(async request => { observations.push(request); });
  try {
    await f.start('A');
    const oversized = { ...f.pre(), tool_input: { command: 'x'.repeat(65 * 1024) } };
    assert.deepEqual(await invoke(f.hook('PreToolUse'), oversized), {});
    await invoke(f.hook('PreToolUse'), f.pre()); await invoke(f.hook('PostToolUse'), f.post());
    assert.equal(observations.length, 1); const gap = observations[0]!;
    assert.equal(gap.phase, 'gap'); assert.equal('toolInput' in gap, false);
    assert.deepEqual(await f.session.checkReadiness(), { ok: true, value: undefined });
  } finally { await f.session.close(); }
});

test('conflicting duplicate pre tool identity or input invalidates the original pending capture before joining', async () => {
  for (const conflict of ['name', 'input'] as const) {
    const pending = deferred(), observations: ClaudeCaptureRequest[] = [];
    const f = await fixture(async request => { observations.push(request); if (request.phase === 'before') {await pending.promise;} });
    try {
      await f.start('A'); const first = invoke(f.hook('PreToolUse'), f.pre());
      const changed = conflict === 'name' ? { ...f.pre(), tool_name: 'Read' } : { ...f.pre(), tool_input: { command: 'different effect' } };
      const duplicate = invoke(f.hook('PreToolUse'), changed);
      await setImmediate();
      assert.deepEqual(observations.map(request => [request.phase, request.inputId]), [['before', 'input-A'], ['gap', 'input-A']]);
      pending.resolve(); assert.deepEqual(await first, {}); assert.deepEqual(await duplicate, {});
      await invoke(f.hook('PostToolUse'), f.post());
      assert.deepEqual(observations.map(request => request.phase), ['before', 'gap']);
    } finally { pending.resolve(); await f.session.close(); }
  }
});

test('conflicting post input or outcome invalidates a pending after observation and cannot settle as success', async () => {
  for (const conflict of ['input', 'outcome'] as const) {
    const pending = deferred(), observations: ClaudeCaptureRequest[] = [];
    const f = await fixture(async request => { observations.push(request); if (request.phase === 'after') {await pending.promise;} });
    try {
      await f.start('A'); await invoke(f.hook('PreToolUse'), f.pre());
      const first = invoke(f.hook('PostToolUse'), f.post());
      await setImmediate(); assert.equal(observations.at(-1)?.phase, 'after');
      const duplicate = conflict === 'input'
        ? invoke(f.hook('PostToolUse'), { ...f.post(), tool_input: { command: 'different effect' } })
        : invoke(f.hook('PostToolUseFailure'), f.failed());
      await duplicate;
      assert.deepEqual(observations.map(request => [request.phase, request.inputId]), [['before', 'input-A'], ['after', 'input-A'], ['gap', 'input-A']]);
      pending.resolve(); assert.deepEqual(await first, {});
      await invoke(f.hook('PostToolUse'), f.post());
      assert.deepEqual(observations.map(request => request.phase), ['before', 'after', 'gap']);
    } finally { pending.resolve(); await f.session.close(); }
  }
});
