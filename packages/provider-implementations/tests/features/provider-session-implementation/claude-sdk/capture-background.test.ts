import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate, setTimeout as wait } from 'node:timers/promises';
import type { HookInput, PostToolUseHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { openClaudeSession } from '../../../../src/claude.ts';
import type { ClaudeCapturePort, ClaudeCaptureRequest } from '../../../../src/claude.ts';
import { configuration, QueryFixture } from './support.ts';

type BackgroundRequest = Parameters<NonNullable<ClaudeCapturePort['observeBackground']>>[0];
async function fixture(timeoutMs = 300, observe: (request: BackgroundRequest) => Promise<void> = async () => {}, batches = true) {
  const sdk = new QueryFixture(), config = configuration();
  const observations: ClaudeCaptureRequest[] = [], background: BackgroundRequest[] = [];
  let healthy = true; config.probe = async () => healthy;
  config.nativeTools = ['Bash']; config.limits = { ...config.limits, timeoutMs };
  config.capture = { observe: async request => { observations.push(request); }, ...(batches ? { observeBatch: async () => {} } : {}),
    observeBackground: async request => { background.push(request); await observe(request); } };
  const opened = await openClaudeSession(config, undefined, sdk.boundary); assert.ok(opened.ok);
  const session = opened.value;
  const start = async (name: string, tools = [`tool-${name}`]) => {
    assert.ok((await session.submit({ inputId: `input-${name}`, operationRef: `operation-${name}`, content: `TEST ${name}` })).ok);
    await setImmediate(); sdk.emit({ type: 'assistant', parent_tool_use_id: null, user_message_uuid: sdk.inputs.at(-1)?.uuid,
      message: { id: `message-${name}`, content: tools.map(id => ({ type: 'tool_use', id, name: 'Bash', input: { command: id } })) } });
    await setImmediate();
  };
  const pre = (id = 'tool-A'): PreToolUseHookInput => ({ hook_event_name: 'PreToolUse', session_id: sdk.options.sessionId!,
    transcript_path: '/TEST-unused/transcript', cwd: config.cwd, tool_name: 'Bash', tool_use_id: id, tool_input: { command: id } });
  const invoke = async (raw: HookInput) => {
    const hook = sdk.options.hooks?.[raw.hook_event_name]?.[0]?.hooks[0]; assert.ok(hook);
    return hook(raw, 'tool_use_id' in raw ? raw.tool_use_id : 'TEST-batch', { signal: new AbortController().signal });
  };
  const post = (id = 'tool-A', task: string | null = 'task-A'): PostToolUseHookInput => ({ ...pre(id), hook_event_name: 'PostToolUse', tool_response: task ? { backgroundTaskId: task } : {} });
  const task = async (subtype: 'task_started' | 'task_notification', patch: Record<string, unknown> = {}) => {
    sdk.emit({ type: 'system', subtype, session_id: sdk.options.sessionId, task_id: 'task-A', tool_use_id: 'tool-A', run_id: 'run-A',
      ...(subtype === 'task_started' ? { task_type: 'local_bash', is_backgrounded: true } : { status: 'completed', output_file: '/TEST-unused/output', summary: 'TEST' }), ...patch });
    await setImmediate();
  };
  const register = async () => { await invoke(pre()); await task('task_started'); assert.deepEqual(await invoke(post()), {}); };
  const terminal = async () => { sdk.emit({ type: 'result', subtype: 'success', session_id: sdk.options.sessionId, user_message_uuid: sdk.inputs.at(-1)?.uuid }); await setImmediate(); };
  return { sdk, session, observations, background, start, pre, post, invoke, task, register, terminal, setHealthy: (value: boolean) => { healthy = value; } };
}

test('background completion retains the exact original terminal input without borrowing the next turn', async () => {
  const f = await fixture();
  try {
    await f.start('A'); await f.register();
    assert.deepEqual(f.background.map(row => row.phase), ['registered']);
    const registration = f.background[0]!; assert.equal(registration.inputId, 'input-A');
    await f.terminal(); await f.start('B', []);
    assert.equal(registration.signal.aborted, false, 'normal terminal retires execution authority, not this bounded original observation');
    await f.task('task_notification'); await f.task('task_notification');
    assert.deepEqual(f.background.map(row => row.phase), ['registered', 'terminal']);
    const completion = f.background[1]!;
    assert.equal(completion.inputId, 'input-A'); assert.equal(completion.operationRef, 'operation-A');
    assert.equal(completion.toolUseId, 'tool-A'); assert.equal(completion.taskRef, 'task-A'); assert.equal(completion.runRef, 'run-A');
    assert.equal(completion.boundary, 'native-task-notification');
    assert.ok(completion.phase === 'terminal' && completion.status === 'completed');
    assert.equal(f.observations.some(row => row.phase === 'gap'), false);
  } finally { await f.session.close(); }
});

test('a fast native completion waits for the original background post-tool registration', async () => {
  const f = await fixture();
  try {
    await f.start('A'); await f.invoke(f.pre()); await f.task('task_started'); await f.task('task_notification');
    assert.equal(f.background.length, 0);
    assert.deepEqual(await f.invoke(f.post()), {});
    assert.deepEqual(f.background.map(row => row.phase), ['registered', 'terminal']);
  } finally { await f.session.close(); }
});

test('conflicting run identity or native task reuse cannot retarget another original pair', async () => {
  for (const mode of ['run', 'reuse'] as const) {
    const f = await fixture();
    try {
      await f.start('A', ['tool-A', 'tool-B']); await f.register();
      if (mode === 'run') {await f.task('task_notification', { run_id: 'foreign-run' });}
      else { await f.invoke(f.pre('tool-B')); await f.invoke(f.post('tool-B', 'task-A')); }
      assert.equal(f.background.filter(row => row.phase === 'terminal').length, 0);
      assert.ok(f.observations.some(row => row.phase === 'gap' && row.inputId === 'input-A'));
    } finally { await f.session.close(); }
  }
});

test('interrupt and close abort original background observation without changing tool permission or replaying input', async () => {
  for (const mode of ['interrupt', 'close'] as const) {
    const f = await fixture();
    try {
      await f.start('A'); await f.register(); const original = f.background[0]!;
      if (mode === 'interrupt') {assert.ok((await f.session.interrupt('operation-A')).ok);}
      else {await f.session.close();}
      assert.equal(original.signal.aborted, true);
      await f.task('task_notification');
      assert.equal(f.background.filter(row => row.phase === 'terminal').length, 0);
      assert.equal(f.sdk.inputs.length, 1);
      assert.ok(f.observations.some(row => row.phase === 'gap' && row.inputId === 'input-A'));
    } finally { await f.session.close(); }
  }
});

test('missing registration identity and expired background task retain gaps instead of guessed completion', async () => {
  for (const mode of ['missing', 'deadline'] as const) {
    const f = await fixture(20);
    try {
      await f.start('A');
      if (mode === 'missing') {
        const pre = { ...f.pre(), tool_input: { command: 'tool-A', run_in_background: true } };
        await f.invoke(pre); await f.invoke({ ...pre, hook_event_name: 'PostToolUse', tool_response: {} });
      } else { await f.register(); await wait(35); }
      await f.task('task_notification');
      assert.equal(f.background.filter(row => row.phase === 'terminal').length, 0);
      assert.ok(f.observations.some(row => row.phase === 'gap' && row.inputId === 'input-A'));
    } finally { await f.session.close(); }
  }
});

test('overlapping sibling native tools gap both intervals and still return the original empty hook decision', async () => {
  const f = await fixture();
  try {
    await f.start('A', ['tool-A', 'tool-B']); await f.register();
    assert.deepEqual(await f.invoke(f.pre('tool-B')), {});
    assert.deepEqual(await f.invoke(f.post('tool-B', null)), {});
    await f.task('task_notification');
    assert.equal(f.background.filter(row => row.phase === 'terminal').length, 0);
    for (const id of ['tool-A', 'tool-B']) {assert.ok(f.observations.some(row => row.phase === 'gap' && row.toolUseId === id));}
  } finally { await f.session.close(); }
});

test('stopped native task is observed as stopped and remains an explicit incomplete capture', async () => {
  const f = await fixture();
  try {
    await f.start('A'); await f.register(); await f.task('task_notification', { status: 'stopped' });
    const completion = f.background.find(row => row.phase === 'terminal');
    assert.ok(completion?.phase === 'terminal' && completion.status === 'stopped');
    assert.ok(f.observations.some(row => row.phase === 'gap' && row.inputId === 'input-A'));
  } finally { await f.session.close(); }
});

test('background observation failure stays one original gap and cannot deny the native Bash hook', async () => {
  const f = await fixture(300, async () => { throw new Error('TEST private observer failure'); });
  try {
    await f.start('A'); await f.invoke(f.pre()); await f.task('task_started');
    assert.deepEqual(await f.invoke(f.post()), {}); await f.task('task_notification');
    assert.equal(f.background.length, 1);
    assert.ok(f.observations.some(row => row.phase === 'gap' && row.reason === 'capture-failed'));
    assert.deepEqual(await f.session.checkReadiness(), { ok: true, value: undefined });
  } finally { await f.session.close(); }
});


test('a nested native notification cannot complete a main-thread background pair', async () => {
  const f = await fixture();
  try {
    await f.start('A'); await f.register(); await f.task('task_notification', { agent_id: 'foreign-child' });
    assert.equal(f.background.filter(row => row.phase === 'terminal').length, 0);
    assert.ok(f.observations.some(row => row.phase === 'gap' && row.reason === 'conflict'));
  } finally { await f.session.close(); }
});

test('duplicate post hooks and fast completion join the original pending registration exactly once', async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(300, async request => { if (request.phase === 'registered') { entered(); await held; } });
  try {
    await f.start('A'); await f.invoke(f.pre()); await f.task('task_started');
    const first = f.invoke(f.post()); await ready;
    let duplicateDone = false;
    const duplicate = f.invoke(f.post()).then(value => { duplicateDone = true; return value; });
    await f.task('task_notification'); assert.equal(duplicateDone, false);
    release(); await Promise.all([first, duplicate]); await setImmediate();
    assert.deepEqual(f.background.map(row => row.phase), ['registered', 'terminal']);
  } finally { release(); await f.session.close(); }
});


test('background-only consumers retire an earlier foreground pair before retaining a later native task', async () => {
  const f = await fixture(300, async () => {}, false);
  try {
    await f.start('A'); await f.invoke(f.pre()); await f.invoke(f.post('tool-A', null)); await f.terminal();
    await f.start('B'); await f.invoke(f.pre('tool-B'));
    await f.task('task_started', { tool_use_id: 'tool-B', task_id: 'task-B', run_id: 'run-B' });
    await f.invoke(f.post('tool-B', 'task-B'));
    await f.task('task_notification', { tool_use_id: 'tool-B', task_id: 'task-B', run_id: 'run-B' });
    assert.deepEqual(f.background.map(row => [row.phase, row.inputId]), [['registered', 'input-B'], ['terminal', 'input-B']]);
    assert.equal(f.observations.some(row => row.phase === 'gap'), false);
  } finally { await f.session.close(); }
});


test('optional native run IDs allow consistent absence and preserve asymmetric bookends as gaps', async () => {
  for (const mode of ['absent', 'introduced', 'missing'] as const) {
    const f = await fixture();
    try {
      await f.start('A'); await f.invoke(f.pre());
      await f.task('task_started', mode === 'missing' ? {} : { run_id: undefined });
      await f.invoke(f.post());
      await f.task('task_notification', mode === 'introduced' ? {} : { run_id: undefined });
      assert.equal(f.background.filter(row => row.phase === 'terminal').length, mode === 'absent' ? 1 : 0);
      assert.equal(f.observations.some(row => row.phase === 'gap'), mode !== 'absent');
    } finally { await f.session.close(); }
  }
});


test('session-wide unknown failure revokes retained observations from an earlier normal terminal', async () => {
  const f = await fixture();
  try {
    await f.start('A'); await f.register(); await f.terminal();
    const registration = f.background[0]!;
    f.sdk.emit({ type: 'system', subtype: 'status', session_id: 'foreign-session' }); await setImmediate();
    assert.equal(registration.signal.aborted, true);
    await f.task('task_notification');
    assert.equal(f.background.filter(row => row.phase === 'terminal').length, 0);
    assert.ok(f.observations.some(row => row.phase === 'gap' && row.inputId === 'input-A'));
  } finally { await f.session.close(); }
});

test('idle readiness failure revokes earlier observations while recovery still captures a fresh original input', async () => {
  const f = await fixture();
  try {
    await f.start('A'); await f.register(); await f.terminal();
    const original = f.background[0]!;
    f.setHealthy(false);
    assert.deepEqual(await f.session.checkReadiness(), { ok: false, code: 'dependency-unavailable' });
    assert.equal(original.signal.aborted, true, 'dependency loss revokes the retained A observation');
    f.setHealthy(true);
    assert.deepEqual(await f.session.checkReadiness(), { ok: true, value: undefined });
    await f.start('B'); await f.invoke(f.pre('tool-B'));
    await f.task('task_started', { tool_use_id: 'tool-B', task_id: 'task-B', run_id: 'run-B' });
    await f.invoke(f.post('tool-B', 'task-B'));
    await f.task('task_notification'); // A stays revoked after recovery; never retarget it to B.
    await f.task('task_notification', { tool_use_id: 'tool-B', task_id: 'task-B', run_id: 'run-B' });
    assert.deepEqual(f.observations.filter(row => row.inputId === 'input-B').map(row => row.phase), ['before', 'after']);
    assert.deepEqual(f.background.map(row => [row.phase, row.inputId]),
      [['registered', 'input-A'], ['registered', 'input-B'], ['terminal', 'input-B']]);
    assert.equal(f.sdk.inputs.length, 2);
  } finally { await f.session.close(); }
});
