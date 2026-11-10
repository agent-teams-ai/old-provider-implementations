import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate, setTimeout as wait } from 'node:timers/promises';
import type { HookCallback, HookInput, PostToolBatchHookInput, PostToolUseHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { openClaudeSession } from '../../../../src/claude.ts';
import type { ClaudeCaptureBatchRequest, ClaudeCaptureRequest } from '../../../../src/claude.ts';
import { ClaudeCapture } from '../../../../src/features/provider-session-implementation/adapters/claude-sdk/capture.ts';
import { configuration, QueryFixture } from './support.ts';

function deferred() { let finish!: () => void; return { promise: new Promise<void>(resolve => { finish = resolve; }), resolve: () => finish() }; }
function retainedPre(id: string): PreToolUseHookInput {
  return { hook_event_name: 'PreToolUse', session_id: 'TEST-native', transcript_path: '/TEST/transcript',
    cwd: '/TEST/workspace', tool_name: 'Bash', tool_use_id: id, tool_input: { s: 'aaaa' } };
}
async function fixture(onBatch: (request: ClaudeCaptureBatchRequest) => Promise<void> = async () => {}, timeoutMs = 300) {
  const sdk = new QueryFixture(), config = configuration();
  const observations: ClaudeCaptureRequest[] = [], batches: ClaudeCaptureBatchRequest[] = [];
  config.nativeTools = ['Bash', 'Read', 'Edit']; config.limits = { ...config.limits, timeoutMs };
  config.capture = { observe: async request => { observations.push(request); }, observeBatch: async request => { batches.push(request); await onBatch(request); } };
  const opened = await openClaudeSession(config, undefined, sdk.boundary); assert.ok(opened.ok);
  const session = opened.value;
  const hook = (phase: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PostToolBatch'): HookCallback => {
    const callback = sdk.options.hooks?.[phase]?.[0]?.hooks[0]; assert.ok(callback); return callback;
  };
  const pre = (id = 'tool-A'): PreToolUseHookInput => ({ hook_event_name: 'PreToolUse', session_id: sdk.options.sessionId!,
    transcript_path: '/TEST-unused/transcript', cwd: config.cwd, tool_name: 'Bash', tool_use_id: id, tool_input: { command: id } });
  const post = (id = 'tool-A'): PostToolUseHookInput => ({ ...pre(id), hook_event_name: 'PostToolUse', tool_response: {} });
  const batch = (ids = ['tool-A']): PostToolBatchHookInput => ({ hook_event_name: 'PostToolBatch', session_id: sdk.options.sessionId!,
    transcript_path: '/TEST-unused/transcript', cwd: config.cwd, tool_calls: ids.map(id => { const { tool_name, tool_input, tool_use_id } = pre(id); return { tool_name, tool_input, tool_use_id, tool_response: {} }; }) });
  const invoke = (phase: Parameters<typeof hook>[0], input: HookInput = phase === 'PreToolUse' ? pre() : phase === 'PostToolBatch' ? batch() : post()) =>
    hook(phase)(input, 'tool_use_id' in input ? input.tool_use_id : 'hook-TEST-native-batch', { signal: new AbortController().signal });
  const start = async (name: string, ids = [`tool-${name}`], toolName = 'Bash') => {
    assert.ok((await session.submit({ inputId: `input-${name}`, operationRef: `operation-${name}`, content: `TEST ${name}` })).ok);
    await setImmediate(); sdk.emit({ type: 'assistant', parent_tool_use_id: null, user_message_uuid: sdk.inputs.at(-1)?.uuid,
      message: { id: `message-${name}`, content: ids.map(id => ({ type: 'tool_use', id, name: toolName, input: { command: id } })) } }); await setImmediate();
  };
  const terminal = () => sdk.emit({ type: 'result', subtype: 'success', session_id: sdk.options.sessionId, user_message_uuid: sdk.inputs.at(-1)?.uuid });
  const pair = async (id = 'tool-A') => { await invoke('PreToolUse', pre(id)); await invoke('PostToolUse', post(id)); };
  return { sdk, config, session, observations, batches, pre, post, batch, invoke, start, terminal, pair };
}

test('native batch hook awaits one original-owned observation and terminal cannot release the next input through it', async () => {
  const gate = deferred(); const f = await fixture(async () => gate.promise);
  try {
    await f.start('A'); await f.pair();
    const first = f.invoke('PostToolBatch'), duplicate = f.invoke('PostToolBatch');
    let returned = false; void first.then(() => (returned = true));
    await setImmediate(); assert.equal(returned, false); assert.equal(f.batches.length, 1);
    const batch = f.batches[0]!; assert.equal(batch.inputId, 'input-A'); assert.equal(batch.operationRef, 'operation-A');
    assert.equal(batch.boundary, 'post-tool-use-hooks'); assert.ok(Object.isFrozen(batch) && Object.isFrozen(batch.tools));
    assert.deepEqual(batch.tools, [{ toolUseId: 'tool-A', toolName: 'Bash', toolInput: { command: 'tool-A' }, outcome: 'succeeded' }]);
    const next = f.session.submit({ inputId: 'input-B', operationRef: 'operation-B', content: 'TEST B' });
    f.terminal(); await setImmediate(); assert.equal(f.sdk.inputs.length, 1);
    gate.resolve(); assert.deepEqual(await first, {}); assert.deepEqual(await duplicate, {}); assert.ok((await next).ok);
    await setImmediate(); assert.equal(f.sdk.inputs.length, 2);
    await f.invoke('PostToolBatch'); assert.equal(f.batches.length, 1, 'late duplicate never retargets the next input');
  } finally { gate.resolve(); await f.session.close(); }
});

test('mapped post-tool callbacks remain provisional and batch observes their awaited effects', async () => {
  let effects = 0, batchEffects = 0;
  const f = await fixture(async () => { batchEffects = effects; });
  try {
    await f.start('A'); await f.invoke('PreToolUse');
    await Promise.all([f.invoke('PostToolUse'), (async () => { effects++; await setImmediate(); effects++; })()]);
    assert.equal(f.observations.at(-1)?.phase, 'after'); assert.equal(f.batches.length, 0);
    await f.invoke('PostToolBatch'); assert.equal(batchEffects, 2); assert.equal(f.batches.length, 1);
    assert.equal(f.sdk.options.permissionMode, 'default'); assert.deepEqual(f.sdk.options.allowedTools, []);
  } finally { await f.session.close(); }
});

test('wrong native session/child and conflicting batch fingerprints cannot borrow the active owner', async () => {
  const f = await fixture();
  try {
    await f.start('A'); await f.pair();
    await f.invoke('PostToolBatch', { ...f.batch(), session_id: 'foreign' });
    await f.invoke('PostToolBatch', { ...f.batch(), agent_id: 'child' }); assert.equal(f.batches.length, 0);
    const conflicting = f.batch(); conflicting.tool_calls[0]!.tool_input = { command: 'different' };
    await f.invoke('PostToolBatch', conflicting); assert.equal(f.batches.length, 0);
    assert.equal(f.observations.at(-1)?.phase, 'gap'); assert.equal(f.observations.at(-1)?.inputId, 'input-A');
    await f.invoke('PostToolBatch'); assert.equal(f.batches.length, 0);
  } finally { await f.session.close(); }
});

test('contradictory duplicate during an awaited batch aborts that original observation and leaves permanent gaps', async () => {
  const gate = deferred(); const f = await fixture(async () => gate.promise);
  try {
    await f.start('A'); await f.pair(); const pending = f.invoke('PostToolBatch'); await setImmediate();
    const changed = f.batch(); changed.tool_calls[0]!.tool_name = 'Read';
    await f.invoke('PostToolBatch', changed); assert.equal(f.batches[0]!.signal.aborted, true);
    assert.deepEqual(await pending, {}); gate.resolve();
    await f.invoke('PostToolBatch'); assert.equal(f.batches.length, 1);
    assert.deepEqual(f.observations.filter(row => row.phase === 'gap').map(row => row.inputId), ['input-A']);
  } finally { gate.resolve(); await f.session.close(); }
});

test('missing native batch callback gaps before terminal release and cannot be adopted by the next input', async () => {
  const f = await fixture();
  try {
    await f.start('A'); await f.pair(); f.terminal(); await setImmediate(); await f.start('B');
    const gap = f.observations.at(-1)!; assert.equal(gap.phase, 'gap'); if (gap.phase === 'gap') {assert.equal(gap.reason, 'missing-batch');}
    assert.equal(gap.inputId, 'input-A'); await f.invoke('PostToolBatch'); assert.equal(f.batches.length, 0);
    await f.pair('tool-B'); await f.invoke('PostToolBatch', f.batch(['tool-B'])); assert.equal(f.batches[0]?.inputId, 'input-B');
  } finally { await f.session.close(); }
});

test('missing batch deadline releases bounded retained bytes and never denies native tools', async () => {
  const f = await fixture(async () => {}, 20);
  try {
    await f.start('A'); await f.pair(); await wait(35);
    const gap = f.observations.at(-1)!; assert.equal(gap.phase, 'gap'); if (gap.phase === 'gap') {assert.equal(gap.reason, 'missing-batch');}
    assert.deepEqual(await f.invoke('PostToolBatch'), {}); assert.equal(f.batches.length, 0);
    assert.deepEqual(await f.session.checkReadiness(), { ok: true, value: undefined });
  } finally { await f.session.close(); }
});

test('explicit and automatic background Bash are gaps after provisional outcome and cannot complete a batch', async () => {
  for (const automatic of [false, true]) {
    const f = await fixture();
    try {
      await f.start('A'); const pre = f.pre(), post = f.post(), batch = f.batch();
      if (automatic) {post.tool_response = { backgroundTaskId: 'TEST-bg' };}
      else {pre.tool_input = post.tool_input = batch.tool_calls[0]!.tool_input = { command: 'tool-A', run_in_background: true };}
      await f.invoke('PreToolUse', pre); await f.invoke('PostToolUse', post); await f.invoke('PostToolBatch', batch);
      assert.equal(f.batches.length, 0); const gap = f.observations.at(-1)!; assert.equal(gap.phase, 'gap');
      if (gap.phase === 'gap') {assert.equal(gap.reason, 'background');} assert.equal(gap.inputId, 'input-A');
      assert.deepEqual(f.observations.map(row => row.phase), ['before', 'after', 'gap']);
    } finally { await f.session.close(); }
  }
});

test('batch callback rejection, timeout, interrupt and close never publish a replacement owner or change tool outputs', async () => {
  for (const mode of ['reject', 'deadline', 'interrupt', 'close'] as const) {
    const gate = deferred(); const f = await fixture(async () => { if (mode === 'reject') {throw new Error('TEST failure');} await gate.promise; }, 25);
    try {
      await f.start('A'); await f.pair(); const pending = f.invoke('PostToolBatch'); await setImmediate();
      if (mode === 'interrupt') {assert.ok((await f.session.interrupt('operation-A')).ok);}
      if (mode === 'close') {assert.deepEqual(await f.session.close(), { logicallyClosed: true, cleanup: 'confirmed' });}
      assert.deepEqual(await pending, {}); assert.equal(f.observations.at(-1)?.phase, 'gap'); assert.equal(f.observations.at(-1)?.inputId, 'input-A');
      assert.equal(f.batches[0]?.signal.aborted, true); assert.equal(f.batches.length, 1);
    } finally { gate.resolve(); await f.session.close(); }
  }
});

test('one batch carries only exact same-owner tool IDs; mixed unknown IDs or repeated IDs gap the retained group', async () => {
  for (const ids of [['tool-A', 'unknown'], ['tool-A', 'tool-A'], ['tool-A', 'tool-C']]) {
    const f = await fixture();
    try {
      await f.start('A', ['tool-A', 'tool-C']); await f.pair();
      if (ids[1] === 'tool-C') {await f.pair('tool-C');}
      await f.invoke('PostToolBatch', f.batch(ids));
      assert.equal(f.batches.length, ids[1] === 'tool-C' ? 1 : 0);
      if (ids[1] === 'tool-C') {assert.deepEqual(f.batches[0]!.tools.map(tool => tool.toolUseId), ids);}
      else {assert.equal(f.observations.some(row => row.phase === 'gap' && row.inputId === 'input-A'), true);}
    } finally { await f.session.close(); }
  }
});

test('absence of optional observeBatch preserves legacy capture hooks and releases after pairs normally', async () => {
  const sdk = new QueryFixture(), config = configuration(); config.capture = { observe: async () => {} };
  const opened = await openClaudeSession(config, undefined, sdk.boundary); assert.ok(opened.ok);
  try {assert.equal(sdk.options.hooks?.PostToolBatch, undefined);} finally {await opened.value.close();}
});

test('failed native outcome reaches the batch and caller mutation cannot replace the captured callback', async () => {
  const f = await fixture();
  try {
    f.config.capture = { observe: async () => {}, observeBatch: async () => { throw new Error('late replacement'); } };
    await f.start('A'); await f.invoke('PreToolUse');
    await f.invoke('PostToolUseFailure', { ...f.pre(), hook_event_name: 'PostToolUseFailure', error: 'TEST failed command' });
    await f.invoke('PostToolBatch'); assert.equal(f.batches.length, 1); assert.equal(f.batches[0]!.tools[0]!.outcome, 'failed');
  } finally { await f.session.close(); }
});

test('provisional pairs retain bounded input bytes until batch settlement and release them without evicting identity', async () => {
  const observations: ClaudeCaptureRequest[] = [], revocation = new AbortController();
  const capture = new ClaudeCapture({ port: { observe: async request => { observations.push(request); }, observeBatch: async () => {} },
    sessionRef: 'TEST-session', nativeSession: 'TEST-native', names: ['Bash'], maxPairs: 4, maxBytes: 16, timeoutMs: 100,
    currentOwner: () => ({ inputId: 'TEST-input', operationRef: 'TEST-operation', nativeRef: 'TEST-native-input', revoked: revocation.signal }) });
  const pre = retainedPre;
  const signal = new AbortController().signal;
  try {
    await capture.hook(pre('first'), 'first', { signal });
    await capture.hook({ ...pre('first'), hook_event_name: 'PostToolUse', tool_response: {} }, 'first', { signal });
    await capture.hook(pre('second'), 'second', { signal });
    const limit = observations.at(-1)!; assert.equal(limit.phase, 'gap'); if (limit.phase === 'gap') {assert.equal(limit.reason, 'limit');}
    const { tool_name, tool_input, tool_use_id } = pre('first');
    await capture.batchHook({ hook_event_name: 'PostToolBatch', session_id: 'TEST-native', transcript_path: '/TEST/transcript', cwd: '/TEST/workspace',
      tool_calls: [{ tool_name, tool_input, tool_use_id }] }, undefined, { signal });
    await capture.hook(pre('third'), 'third', { signal }); assert.equal(observations.at(-1)?.phase, 'before');
    // Completed identity remains a tombstone. A contradictory late callback gaps first, never third.
    await capture.hook({ ...pre('first'), tool_name: 'Bash', tool_input: { s: 'bbbb' } }, 'first', { signal });
    assert.equal(observations.at(-1)?.toolUseId, 'first'); assert.equal(observations.at(-1)?.phase, 'gap');
  } finally { await capture.close(); }
});

test('native Edit default-key ordering in PostToolBatch preserves semantic input identity and still rejects changed values', async () => {
  const f = await fixture();
  try {
    await f.start('A', ['tool-A'], 'Edit');
    const original = { file_path: '/TEST/file', old_string: 'old', new_string: 'new', replace_all: false };
    const pre = { ...f.pre(), tool_name: 'Edit', tool_input: original };
    await f.invoke('PreToolUse', pre);
    await f.invoke('PostToolUse', { ...f.post(), tool_name: 'Edit', tool_input: original });
    const batch = f.batch(); batch.tool_calls[0] = { tool_name: 'Edit', tool_use_id: 'tool-A',
      tool_input: { replace_all: false, file_path: '/TEST/file', old_string: 'old', new_string: 'new' } };
    await f.invoke('PostToolBatch', batch); assert.equal(f.batches.length, 1);
    assert.deepEqual(f.batches[0]!.tools[0]!.toolInput, original, 'retained preimage input is not rewritten');
    await f.invoke('PostToolBatch', batch); assert.equal(f.batches.length, 1);
    batch.tool_calls[0]!.tool_input = { ...original, new_string: 'other effect' };
    await f.invoke('PostToolBatch', batch); assert.equal(f.observations.at(-1)?.phase, 'gap');
    assert.equal(f.observations.at(-1)?.inputId, 'input-A');
  } finally { await f.session.close(); }
});
