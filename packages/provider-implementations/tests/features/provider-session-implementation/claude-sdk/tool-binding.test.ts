import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate, setTimeout as wait } from 'node:timers/promises';
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { toolBindingHook } from '../../../../src/features/provider-session-implementation/adapters/claude-sdk/tool-binding.ts';
import type { ForegroundToolOwner } from '../../../../src/features/provider-session-implementation/adapters/claude-sdk/tool-binding.ts';
import type { ClaudeToolBindingRequest } from '../../../../src/claude.ts';
import { openClaudeSession } from '../../../../src/claude.ts';
import { configuration, QueryFixture } from './support.ts';

const input = (prompt = 'independent-native-prompt-id'): PreToolUseHookInput => ({ hook_event_name: 'PreToolUse', session_id: 'native-session',
  transcript_path: '/TEST-unused/transcript', cwd: '/TEST-unused/workspace', prompt_id: prompt,
  tool_name: 'mcp__control__message_send', tool_input: { nested: { text: 'TEST' } }, tool_use_id: 'native-tool-1' });
const names = ['mcp__control__message_send'];
const invoke = (hook: HookCallback, value = input(), id: string | undefined = 'native-tool-1') => hook(value, id, { signal: new AbortController().signal });
const owner = (): ForegroundToolOwner => ({ inputId: 'input-A', operationRef: 'operation-A', nativeRef: 'native-A', revoked: new AbortController().signal });
const deny = (value: unknown) => assert.deepEqual(value, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Tool binding unavailable' } });

function deferred<T>() { let finish!: (value: T) => void; return { promise: new Promise<T>(resolve => { finish = resolve; }), resolve: (value: T) => finish(value) }; }

test('trusted tool binding captures native ownership and copied payload without granting a permission', async () => {
  const original = input(); const pending = deferred<Readonly<{ updatedInput: Record<string, unknown> }>>();
  let captured: ClaudeToolBindingRequest | undefined;
  const selected = owner();
  const hook = toolBindingHook({ matchedToolNames: names, prepare: request => { captured = request; return pending.promise; } }, 'runtime-session', 'native-session', () => selected, 1000);
  const running = invoke(hook, original);
  (original.tool_input as { nested: { text: string } }).nested.text = 'mutated';
  assert.ok(captured && Object.isFrozen(captured));
  assert.deepEqual(captured.toolInput, { nested: { text: 'TEST' } });
  assert.equal(captured.sessionRef, 'runtime-session'); assert.equal(captured.inputId, 'input-A');
  assert.equal(captured.operationRef, 'operation-A'); assert.equal(captured.nativeToolUseId, 'native-tool-1');
  const result = { updatedInput: { opaque: { reference: 'Host-owned' } } };
  pending.resolve(result);
  const reply = await running;
  result.updatedInput.opaque.reference = 'later-mutation';
  assert.deepEqual(reply, { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { opaque: { reference: 'Host-owned' } } } });
});

test('unknown and conflicting native tool attribution and background never borrow current input', async () => {
  let active: ForegroundToolOwner | undefined = owner(); let calls = 0;
  const hook = toolBindingHook({ matchedToolNames: names, prepare: async () => { calls++; return { updatedInput: {} }; } }, 'runtime-session', 'native-session', (toolId, toolName) => toolId === 'native-tool-1' && toolName === names[0] && active?.nativeRef === 'native-A' ? active : undefined, 1000);
  for (const value of [{ ...input(), session_id: 'other' }, { ...input(), agent_id: 'background' },
    { ...input(), tool_use_id: 'conflict' }]) { deny(await invoke(hook, value)); }
  deny(await invoke(hook, { ...input(), tool_use_id: 'unknown-native' }, 'unknown-native'));
  deny(await hook(input(), undefined, { signal: new AbortController().signal }));
  active = { ...owner(), inputId: 'input-B', operationRef: 'operation-B', nativeRef: 'native-B' };
  deny(await invoke(hook));
  active = undefined; deny(await invoke(hook));
  assert.deepEqual(await invoke(hook, { ...input(), tool_name: 'Read' }), {});
  assert.equal(calls, 0);
});

test('prepare rejection, deadline and late result fail closed with redacted reason', async () => {
  const selected = owner(); const pending = deferred<{ updatedInput: Record<string, unknown> }>();
  let signal: AbortSignal | undefined;
  const hook = toolBindingHook({ matchedToolNames: names, prepare: request => { signal = request.signal; return pending.promise; } }, 'runtime-session', 'native-session', () => selected, 20);
  const [expired] = await Promise.all([invoke(hook), wait(30)]);
  deny(expired); assert.ok(signal?.aborted);
  pending.resolve({ updatedInput: { late: 'cannot-grant' } });
  const throwing = toolBindingHook({ matchedToolNames: names, prepare: async () => { throw new Error('sensitive Host failure'); } }, 'runtime-session', 'native-session', () => selected, 1000);
  deny(await invoke(throwing));
});

test('synchronous SDK abort observes a rejecting Host promise and ownership change cannot admit its late result', async () => {
  const sdkAbort = new AbortController(); let active = owner();
  const hook = toolBindingHook({ matchedToolNames: names, prepare: () => {
    sdkAbort.abort(); return Promise.reject(new Error('sensitive late rejection'));
  } }, 'runtime-session', 'native-session', () => active, 1000);
  deny(await hook(input(), 'native-tool-1', { signal: sdkAbort.signal }));
  await setImmediate();
  const delayed = deferred<{ updatedInput: Record<string, unknown> }>();
  const changing = toolBindingHook({ matchedToolNames: names, prepare: () => delayed.promise }, 'runtime-session', 'native-session', () => active, 1000);
  const running = invoke(changing);
  active = { ...owner(), inputId: 'B', operationRef: 'B', nativeRef: 'native-B' };
  delayed.resolve({ updatedInput: { late: 'cannot-attach-B' } }); deny(await running);
});

test('session interrupt, observed terminal and close revoke preparation and cannot attach A to B', async () => {
  for (const action of ['interrupt', 'terminal', 'close'] as const) {
    const sdk = new QueryFixture(); const c = configuration();
    const prepared = deferred<{ updatedInput: Record<string, unknown> }>(); let captured: ClaudeToolBindingRequest | undefined;
    c.toolBinding = { matchedToolNames: names, prepare: value => { captured = value; return prepared.promise; } };
    const opened = await openClaudeSession(c, undefined, sdk.boundary); assert.ok(opened.ok);
    const session = opened.value;
    try {
      await session.submit({ inputId: 'input-A', operationRef: 'operation-A', content: 'TEST' }); await setImmediate();
      sdk.emit({ type: 'assistant', parent_tool_use_id: null, user_message_uuid: sdk.inputs[0]?.uuid, message: { id: 'native-message', content: [{ type: 'tool_use', id: 'native-tool-1', name: names[0], input: {} }] } }); await setImmediate();
      const hook = sdk.options.hooks?.PreToolUse?.[0]?.hooks[0]; assert.ok(hook);
      const original = { ...input(sdk.inputs[0]!.uuid), session_id: sdk.options.sessionId! };
      const running = invoke(hook, original); assert.ok(captured);
      if (action !== 'close') {
        if (action === 'interrupt') {
          const control = session.interrupt('operation-A'); assert.ok(captured.signal.aborted); deny(await running); await control;
        }
        sdk.emit({ type: 'result', subtype: 'success', session_id: sdk.options.sessionId, user_message_uuid: sdk.inputs[0]?.uuid }); await setImmediate();
        assert.ok(captured.signal.aborted); deny(await running);
        await session.submit({ inputId: 'input-B', operationRef: 'operation-B', content: 'TEST B' }); await setImmediate();
        deny(await invoke(hook, original));
      } else { const closing = session.close(); assert.ok(captured.signal.aborted); deny(await running); await closing; }
      prepared.resolve({ updatedInput: { late: 'denied' } });
    } finally { await session.close(); }
  }
});

test('session binds only observed foreground native tools including partial starts; unknown and background stay closed', async () => {
  const sdk = new QueryFixture(); const c = configuration(); let preparations = 0;
  c.toolBinding = { matchedToolNames: [...names, 'mcp__control__task_update'], prepare: async () => { preparations++; return { updatedInput: {} }; } };
  const opened = await openClaudeSession(c, undefined, sdk.boundary); assert.ok(opened.ok);
  try {
    const session = opened.value;
    await session.submit({ inputId: 'input-A', operationRef: 'operation-A', content: 'TEST' }); await setImmediate();
    const hook = sdk.options.hooks?.PreToolUse?.[0]?.hooks[0]; assert.ok(hook);
    const call = { ...input(), session_id: sdk.options.sessionId! };
    deny(await invoke(hook, call)); assert.equal(preparations, 0, 'current input alone is never sufficient');
    sdk.emit({ type: 'stream_event', parent_tool_use_id: null, user_message_uuid: sdk.inputs[0]?.uuid,
      event: { type: 'message_start', message: { id: 'native-foreground-message' } } });
    sdk.emit({ type: 'stream_event', parent_tool_use_id: null,
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'native-tool-1', name: names[0] } } });
    await setImmediate();
    assert.deepEqual(await invoke(hook, call), { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: {} } });
    deny(await invoke(hook, { ...call, agent_id: 'native-background' }));
    deny(await invoke(hook, { ...call, tool_name: 'mcp__control__task_update' }));
    assert.equal(preparations, 1);
    sdk.emit({ type: 'stream_event', parent_tool_use_id: null,
      event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'native-tool-1', name: 'mcp__control__task_update' } } });
    await setImmediate(); deny(await invoke(hook, call));
    assert.deepEqual(await session.checkReadiness(), { ok: false, code: 'unknown' });
  } finally { await opened.value.close(); }
});

test('cross-input native ID reuse cannot attribute a delayed first A hook to observed B', async () => {
  const sdk = new QueryFixture(); const c = configuration(); let preparations = 0;
  c.toolBinding = { matchedToolNames: names, prepare: async () => { preparations++; return { updatedInput: {} }; } };
  const opened = await openClaudeSession(c, undefined, sdk.boundary); assert.ok(opened.ok);
  try {
    const session = opened.value;
    await session.submit({ inputId: 'A', operationRef: 'A', content: 'A' }); await setImmediate();
    const hook = sdk.options.hooks?.PreToolUse?.[0]?.hooks[0]; assert.ok(hook);
    const assistant = (index: number) => ({ type: 'assistant', parent_tool_use_id: null, user_message_uuid: sdk.inputs[index]?.uuid,
      message: { id: `message-${index}`, content: [{ type: 'tool_use', id: 'native-tool-1', name: names[0], input: {} }] } });
    sdk.emit(assistant(0)); await setImmediate();
    // No hook for A has arrived yet. Native A terminal permits runtime's next input.
    sdk.emit({ type: 'result', subtype: 'success', session_id: sdk.options.sessionId, user_message_uuid: sdk.inputs[0]?.uuid }); await setImmediate();
    await session.submit({ inputId: 'B', operationRef: 'B', content: 'B' }); await setImmediate();
    sdk.emit(assistant(1)); await setImmediate();
    deny(await invoke(hook, { ...input('native-prompt-A'), session_id: sdk.options.sessionId! }));
    assert.equal(preparations, 0);
    assert.deepEqual(await session.checkReadiness(), { ok: false, code: 'unknown' });
  } finally { await opened.value.close(); }
});

test('physical-session native tool tombstones are bounded and cannot evict an old attribution', async () => {
  const sdk = new QueryFixture(); const c = configuration(); c.limits = { ...c.limits, outputEvents: 10 };
  const opened = await openClaudeSession(c, undefined, sdk.boundary); assert.ok(opened.ok);
  const observer = (async () => { for await (const event of opened.value.observe()) { void event; /* Drain normal output independently of the identity bound. */ } })();
  try {
    for (let index = 0; index <= 10; index++) {
      assert.ok((await opened.value.submit({ inputId: `input-${index}`, operationRef: `operation-${index}`, content: 'TEST' })).ok); await setImmediate();
      sdk.emit({ type: 'assistant', parent_tool_use_id: null, user_message_uuid: sdk.inputs[index]?.uuid,
        message: { id: `message-${index}`, content: [{ type: 'tool_use', id: `native-tool-${index}`, name: names[0], input: {} }] } }); await setImmediate();
      if (index < 10) {
        sdk.emit({ type: 'result', subtype: 'success', session_id: sdk.options.sessionId, user_message_uuid: sdk.inputs[index]?.uuid }); await setImmediate();
      }
    }
    assert.deepEqual(await opened.value.checkReadiness(), { ok: false, code: 'output-limit' });
    assert.equal(sdk.calls, 1);
  } finally { await opened.value.close(); await observer; }
});
