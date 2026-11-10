import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { openClaudeSession } from '../../../../src/claude.ts';
import { configuration, QueryFixture } from './support.ts';

/** Pinned SDK0.3.305 inputStream: direct Promise queue, wrapped by readSdkMessages' async generator. */
class SdkQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void) | undefined;
  private ended = false;
  [Symbol.asyncIterator](): AsyncIterableIterator<T> { return this; }
  next(): Promise<IteratorResult<T>> {
    if (this.values.length) { return Promise.resolve({ done: false, value: this.values.shift()! }); }
    if (this.ended) { return Promise.resolve({ done: true, value: undefined }); }
    return new Promise(resolve => { this.waiting = resolve; });
  }
  enqueue(value: T): void {
    if (this.waiting) { const done = this.waiting; this.waiting = undefined; done({ done: false, value }); }
    else { this.values.push(value); }
  }
  done(): void { this.ended = true; this.waiting?.({ done: true, value: undefined }); this.waiting = undefined; }
}
class SchedulingFixture extends QueryFixture {
  readonly trace: string[] = [];
  private readonly sdkStream = new SdkQueue<unknown>();
  override emit(value: unknown): void { this.trace.push('transport-frame'); this.sdkStream.enqueue(value); }
  override async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    for await (const message of this.sdkStream) { this.trace.push('sdk-yield'); yield message; }
  }
  override close(): void { super.close(); this.sdkStream.done(); }
  async stopTask(): Promise<void> {}
  frameThenHook(frame: unknown, input: PreToolUseHookInput): Promise<Awaited<ReturnType<HookCallback>>> {
    this.emit(frame);
    // Query.readMessages continues to the buffered control_request independently of its output consumer.
    return Promise.resolve().then(() => {
      this.trace.push('native-hook');
      return this.options.hooks!.PreToolUse![0]!.hooks[0]!(input, input.tool_use_id, { signal: new AbortController().signal });
    });
  }
}

test('SDK buffered native hook waits for exact foreground tool ownership instead of losing the DO admission race', async () => {
  const sdk = new SchedulingFixture(), config = configuration(); let authorizations = 0;
  config.nativeTools = ['Agent', 'Write'];
  config.subagents = { mode: 'do', tools: ['Write'], authorize: async request => {
    authorizations++; assert.equal(request.inputId, 'input-A'); assert.equal(request.operationRef, 'operation-A'); return true;
  }, observe: async () => {} };
  const opened = await openClaudeSession(config, undefined, sdk.boundary); assert.ok(opened.ok);
  const session = opened.value;
  try {
    assert.ok((await session.submit({ inputId: 'input-A', operationRef: 'operation-A', content: 'TEST SDK scheduling' })).ok);
    await setImmediate();
    const input: PreToolUseHookInput = { hook_event_name: 'PreToolUse', session_id: sdk.options.sessionId!, transcript_path: '/TEST-unused/transcript', cwd: config.cwd,
      tool_name: 'Agent', tool_use_id: 'parent-tool', tool_input: { prompt: 'TEST child', description: 'TEST child', subagent_type: 'host-ordinary', run_in_background: false } };
    const decision = await sdk.frameThenHook({ type: 'assistant', session_id: sdk.options.sessionId, parent_tool_use_id: null, user_message_uuid: sdk.inputs[0]!.uuid,
      message: { id: 'parent-message', content: [{ type: 'tool_use', id: input.tool_use_id, name: 'Agent', input: input.tool_input }] } }, input);
    assert.deepEqual(decision, {}, JSON.stringify(sdk.trace));
    assert.equal(authorizations, 1);
    const child = { ...input, tool_name: 'Write', tool_use_id: 'child-tool', tool_input: { file_path: '/TEST-unused/child.txt', content: 'TEST' }, agent_id: 'child-A' };
    const childDecision = await sdk.frameThenHook({ type: 'system', subtype: 'task_started', session_id: sdk.options.sessionId,
      task_id: 'child-A', tool_use_id: input.tool_use_id, task_type: 'local_agent', subagent_type: 'host-ordinary', is_backgrounded: false }, child);
    assert.deepEqual(childDecision, {}, 'child hook also awaits the actual task_started association');
    const unknownChild = sdk.options.hooks!.PreToolUse![0]!.hooks[0]!({ ...child, agent_id: 'never-started-child' }, child.tool_use_id,
      { signal: new AbortController().signal });
    await setImmediate();
    await session.close();
    const refused = await unknownChild;
    assert.ok('hookSpecificOutput' in refused && refused.hookSpecificOutput && 'permissionDecision' in refused.hookSpecificOutput);
    assert.equal(refused.hookSpecificOutput.permissionDecision, 'deny', 'parent close cancels an unobserved child association');
  } finally { await session.close(); }
});

test('pending parent hook cannot borrow an unrelated native tool or survive original input revocation', async () => {
  const sdk = new SchedulingFixture(), config = configuration(); let authorizations = 0, settled = false;
  config.nativeTools = ['Agent', 'Write'];
  config.subagents = { mode: 'do', tools: ['Write'], authorize: async () => { authorizations++; return true; }, observe: async () => {} };
  const opened = await openClaudeSession(config, undefined, sdk.boundary); assert.ok(opened.ok);
  const session = opened.value;
  try {
    assert.ok((await session.submit({ inputId: 'input-A', operationRef: 'operation-A', content: 'TEST unknown native tool' })).ok);
    await setImmediate();
    const input: PreToolUseHookInput = { hook_event_name: 'PreToolUse', session_id: sdk.options.sessionId!, transcript_path: '/TEST-unused/transcript', cwd: config.cwd,
      tool_name: 'Agent', tool_use_id: 'never-observed-tool', tool_input: { prompt: 'TEST child', description: 'TEST child', subagent_type: 'host-ordinary', run_in_background: false } };
    const pending = sdk.options.hooks!.PreToolUse![0]!.hooks[0]!(input, input.tool_use_id, { signal: new AbortController().signal });
    void Promise.resolve(pending).then(() => { settled = true; return true; });
    sdk.emit({ type: 'assistant', session_id: sdk.options.sessionId, parent_tool_use_id: null, user_message_uuid: sdk.inputs[0]!.uuid,
      message: { id: 'other-message', content: [{ type: 'tool_use', id: 'unrelated-tool', name: 'Agent', input: input.tool_input }] } });
    await setImmediate();
    assert.equal(settled, false); assert.equal(authorizations, 0);
    assert.ok((await session.interrupt('operation-A')).ok);
    const refused = await pending;
    assert.ok('hookSpecificOutput' in refused && refused.hookSpecificOutput && 'permissionDecision' in refused.hookSpecificOutput);
    assert.equal(refused.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(authorizations, 0);
  } finally { await session.close(); }
});
