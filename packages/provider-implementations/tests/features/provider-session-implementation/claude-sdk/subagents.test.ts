import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { Event } from '@agent-teams/provider-session-contracts';
import { openClaudeSession } from '../../../../src/claude.ts';
import type { ClaudeSubagentObservation, ClaudeSubagentAuthorization } from '../../../../src/claude.ts';
import { configuration, QueryFixture } from './support.ts';

class SubagentFixture extends QueryFixture {
  readonly stopped: string[] = [];
  async stopTask(id: string): Promise<void> { this.stopped.push(id); }
}
async function fixture(observer?: (fact: ClaudeSubagentObservation) => Promise<void>, authorize: (request: ClaudeSubagentAuthorization) => Promise<boolean> = async () => true) {
  const sdk = new SubagentFixture(), config = configuration(), facts: ClaudeSubagentObservation[] = [];
  config.nativeTools = ['Agent', 'Read', 'Write']; config.autoAllowedTools = ['Agent', 'Read', 'Write'];
  config.subagents = { mode: 'do', authorize, tools: ['Read', 'Write'], observe: async fact => { facts.push(fact); await observer?.(fact); } };
  const opened = await openClaudeSession(config, undefined, sdk.boundary); assert.ok(opened.ok);
  const session = opened.value, events: Event[] = [];
  const feed = (async () => { for await (const event of session.observe()) {events.push(event);} })();
  const hook = sdk.options.hooks?.PreToolUse?.[0]?.hooks[0]; assert.ok(hook);
  const pre = (tool_name: string, tool_input: unknown, agent_id?: string): PreToolUseHookInput => ({
    hook_event_name: 'PreToolUse', session_id: sdk.options.sessionId!, transcript_path: '/TEST-unused/transcript', cwd: config.cwd,
    tool_name, tool_use_id: tool_name === 'Agent' ? 'parent-tool' : 'child-tool', tool_input, ...(agent_id ? { agent_id } : {}),
  });
  const parent = () => pre('Agent', { prompt: 'TEST write artifact', description: 'TEST child', subagent_type: 'host-ordinary', run_in_background: false });
  const start = async (launchChild = true) => {
    assert.ok((await session.submit({ inputId: 'input-A', operationRef: 'operation-A', content: 'TEST delegate' })).ok);
    await setImmediate();
    sdk.emit({ type: 'assistant', session_id: sdk.options.sessionId, parent_tool_use_id: null, user_message_uuid: sdk.inputs[0]?.uuid,
      message: { id: 'parent-message', content: [{ type: 'tool_use', id: 'parent-tool', name: 'Agent', input: parent().tool_input }] } });
    await setImmediate();
    if (!launchChild) {return;}
    assert.deepEqual(await invoke(hook, parent()), {});
    sdk.emit({ type: 'system', subtype: 'task_started', session_id: sdk.options.sessionId, task_id: 'child-A', tool_use_id: 'parent-tool',
      task_type: 'local_agent', subagent_type: 'host-ordinary', is_backgrounded: false });
    await setImmediate();
  };
  const close = async () => { const receipt = await session.close(); await feed; return receipt; };
  return { sdk, config, session, facts, events, hook, pre, parent, start, close };
}
const invoke = (hook: HookCallback, input: PreToolUseHookInput) => hook(input, input.tool_use_id, { signal: new AbortController().signal });
const denied = (value: Awaited<ReturnType<HookCallback>>) => assert.equal('hookSpecificOutput' in value && value.hookSpecificOutput && 'permissionDecision' in value.hookSpecificOutput ? value.hookSpecificOutput.permissionDecision : undefined, 'deny');

test('ordinary child gate uses native association, rejects model authority and leaves parent MCP available', async () => {
  const f = await fixture();
  try {
    denied(await invoke(f.hook, f.parent())); // No native foreground tool owner.
    await f.start();
    assert.deepEqual(f.sdk.options.agents?.['host-ordinary']?.tools, ['Read', 'Write']);
    assert.equal(f.sdk.options.forwardSubagentText, true);
    for (const patch of [{ team_name: 'foreign' }, { name: 'member' }, { resume: 'other-child' }, { run_in_background: true }, { subagent_type: 'general-purpose' }, { mode: 'bypassPermissions' }, { isolation: 'remote' }]) {
      denied(await invoke(f.hook, { ...f.parent(), tool_input: { ...f.parent().tool_input as object, ...patch } }));
    }
    assert.deepEqual(await invoke(f.hook, f.pre('Write', { file_path: '/TEST-unused/child.txt', content: 'TEST' }, 'child-A')), {});
    for (const tool of ['Agent', 'SendMessage', 'TeamCreate', 'TaskUpdate', 'mcp__team__send_message', 'Bash']) {denied(await invoke(f.hook, f.pre(tool, {}, 'child-A')));}
    denied(await invoke(f.hook, f.pre('Write', {}, 'foreign-child')));
    denied(await invoke(f.hook, { ...f.pre('Write', {}, 'child-A'), session_id: 'foreign-session' }));
    assert.deepEqual(await invoke(f.hook, f.pre('mcp__team__send_message', {})), {});
    assert.deepEqual(await f.sdk.options.canUseTool!('Write', {}, { signal: new AbortController().signal, toolUseID: 'unobserved-tool', agentID: 'child-A', requestId: 'TEST-child-permission' }), { behavior: 'deny', message: 'Child interaction provenance unavailable' });
    assert.deepEqual(await f.sdk.options.canUseTool!('Write', {}, { signal: new AbortController().signal, toolUseID: 'child-tool', requestId: 'TEST-missing-child' }), { behavior: 'deny', message: 'Child interaction provenance unavailable' });
    const permission = f.sdk.options.canUseTool!('Write', { file_path: '/TEST-unused/child.txt' }, { signal: new AbortController().signal, toolUseID: 'child-tool', agentID: 'child-A', requestId: 'TEST-child-permission' });
    await setImmediate();
    const observation = f.facts.at(-1); assert.equal(observation?.phase, 'interaction');
    const event = f.events.find(candidate => candidate.kind === 'interaction'); assert.ok(event && event.kind === 'interaction');
    assert.equal(event.inputId, 'input-A'); assert.equal(event.operationRef, 'operation-A');
    assert.ok(observation?.phase === 'interaction'); assert.equal(observation.childRef, 'child-A'); assert.equal(observation.fact.interactionRef, event.interactionRef);
    assert.deepEqual(f.session.respondToInteraction(event.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: true, value: undefined });
    assert.deepEqual(await permission, { behavior: 'allow', updatedInput: { file_path: '/TEST-unused/child.txt' } });
  } finally { await f.close(); }
});

test('native child transcript and usage retain child provenance without entering parent normalizer', async () => {
  const f = await fixture();
  try {
    await f.start();
    f.sdk.emit({ type: 'assistant', session_id: f.sdk.options.sessionId, agent_id: 'child-A', parent_tool_use_id: 'parent-tool', uuid: 'child-message-uuid',
      message: { id: 'child-message', content: [{ type: 'text', text: 'TEST child transcript' }, { type: 'tool_use', id: 'child-tool', name: 'Write', input: { file_path: '/TEST-unused/child.txt' } }] } });
    f.sdk.emit({ type: 'user', session_id: f.sdk.options.sessionId, parent_tool_use_id: 'parent-tool', message: { content: [{ type: 'tool_result', tool_use_id: 'child-tool', content: 'TEST child effect result' }] } });
    f.sdk.emit({ type: 'system', subtype: 'task_progress', session_id: f.sdk.options.sessionId, task_id: 'child-A', tool_use_id: 'parent-tool', usage: { total_tokens: 27, tool_uses: 1, duration_ms: 50 } });
    await setImmediate();
    assert.deepEqual(f.facts.map(fact => fact.phase), ['started', 'fact', 'fact', 'fact', 'usage']);
    assert.ok(f.facts.every(fact => fact.sessionRef === f.config.sessionRef && fact.inputId === 'input-A' && fact.operationRef === 'operation-A' && fact.childRef === 'child-A' && fact.parentToolRef === 'parent-tool'));
    assert.equal(f.events.some(event => event.kind === 'text' && event.text === 'TEST child transcript'), false);
    assert.equal(f.events.some(event => event.kind === 'usage'), false);
    assert.equal(f.events.some(event => event.kind === 'tool' && event.toolRef === 'child-tool'), false);
    f.sdk.emit({ type: 'result', subtype: 'success', session_id: f.sdk.options.sessionId, user_message_uuid: f.sdk.inputs[0]?.uuid, usage: { input_tokens: 40, output_tokens: 20 } });
    await setImmediate();
    assert.equal(f.events.filter(event => event.kind === 'usage').length, 1);
    denied(await invoke(f.hook, f.pre('Write', {}, 'child-A')));
  } finally { await f.close(); }
});

test('parent close requests only its actual owned native child; cleanup remains Host custody result', async () => {
  const a = await fixture(), b = await fixture();
  try {
    await a.start(); await b.start();
    a.config.custody.confirmStopped = async () => false; // Snapshotting protects the actual selected custody callback.
    assert.deepEqual(await a.close(), { logicallyClosed: true, cleanup: 'confirmed' });
    assert.deepEqual(a.sdk.stopped, ['child-A']); assert.deepEqual(b.sdk.stopped, []);
    assert.deepEqual(await invoke(b.hook, b.pre('Write', {}, 'child-A')), {});
  } finally { await a.close(); await b.close(); }
});

test('missing stop capability and invalid grants reject readiness before accepting input', async () => {
  const f = await fixture();
  await f.close();
  for (const tools of [['mcp__team__send_message'], ['Agent'], ['Bash']]) {
    const config = configuration(); config.nativeTools.push('Agent');
    config.subagents = { mode: 'do', authorize: async () => true, tools, observe: async () => {} };
    assert.deepEqual(await openClaudeSession(config, undefined, new SubagentFixture().boundary), { ok: false, code: 'invalid-config' });
  }
  const config = configuration(); config.nativeTools.push('Agent'); config.subagents = { mode: 'do', authorize: async () => true, tools: ['Read'], observe: async () => {} };
  assert.deepEqual(await openClaudeSession(config, undefined, new QueryFixture().boundary), { ok: false, code: 'unsupported' });
});


test('unassociated native children publish explicit gaps without borrowing the foreground input', async () => {
  const f = await fixture();
  try {
    await f.start();
    f.sdk.emit({ type: 'assistant', session_id: f.sdk.options.sessionId, agent_id: 'unknown-child', parent_tool_use_id: 'unknown-parent',
      message: { id: 'foreign-message', content: [{ type: 'text', text: 'TEST unattributed child' }] } });
    await setImmediate();
    assert.equal(f.facts.at(-1)?.phase, 'gap');
    assert.equal(f.facts.at(-1)?.childRef, 'unknown-child');
    assert.equal(f.facts.at(-1)?.parentToolRef, 'unknown-parent');
    assert.equal(f.facts.at(-1)?.inputId, undefined); assert.equal(f.facts.at(-1)?.operationRef, undefined);
    assert.equal(f.events.some(event => event.kind === 'text' && event.text === 'TEST unattributed child'), false);
  } finally { await f.close(); }
});

test('interrupt cancels a child approval awaiting private provenance; late observation cannot publish or grant', async () => {
  const sdk = new SubagentFixture(), config = configuration(); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  config.nativeTools = ['Agent', 'Write'];
  config.subagents = { mode: 'do', authorize: async () => true, tools: ['Write'], observe: async fact => { if (fact.phase === 'interaction') {await held;} } };
  const opened = await openClaudeSession(config, undefined, sdk.boundary); assert.ok(opened.ok);
  const session = opened.value, events: Event[] = [];
  const feed = (async () => { for await (const event of session.observe()) {events.push(event);} })();
  try {
    assert.ok((await session.submit({ inputId: 'input-A', operationRef: 'operation-A', content: 'TEST approval race' })).ok);
    await setImmediate();
    sdk.emit({ type: 'assistant', session_id: sdk.options.sessionId, parent_tool_use_id: null, user_message_uuid: sdk.inputs[0]?.uuid,
      message: { id: 'message-A', content: [{ type: 'tool_use', id: 'parent-tool', name: 'Agent', input: {} }] } });
    await setImmediate();
    const hook = sdk.options.hooks!.PreToolUse![0]!.hooks[0]!;
    const pre: PreToolUseHookInput = { hook_event_name: 'PreToolUse', session_id: sdk.options.sessionId!, cwd: config.cwd, transcript_path: '/TEST-unused/transcript', tool_name: 'Agent', tool_use_id: 'parent-tool', tool_input: { prompt: 'TEST', description: 'TEST', subagent_type: 'host-ordinary', run_in_background: false } };
    assert.deepEqual(await invoke(hook, pre), {});
    sdk.emit({ type: 'system', subtype: 'task_started', session_id: sdk.options.sessionId, task_id: 'child-A', tool_use_id: 'parent-tool', task_type: 'local_agent', subagent_type: 'host-ordinary', is_backgrounded: false });
    await setImmediate();
    assert.deepEqual(await invoke(hook, { ...pre, tool_name: 'Write', tool_use_id: 'child-tool', agent_id: 'child-A', tool_input: {} }), {});
    const permission = sdk.options.canUseTool!('Write', {}, { signal: new AbortController().signal, toolUseID: 'child-tool', agentID: 'child-A', requestId: 'TEST-child-request' });
    await setImmediate();
    assert.ok((await session.interrupt('operation-A')).ok);
    assert.deepEqual(await permission, { behavior: 'deny', message: 'Interaction cancelled' });
    release(); await setImmediate();
    assert.equal(events.some(event => event.kind === 'interaction'), false);
    assert.deepEqual(session.respondToInteraction('guessed-reference', { kind: 'permission', decision: 'allow' }), { ok: false, code: 'stale' });
  } finally { release(); await session.close(); await feed; }
});

test('empty native child wrappers exhaust the output budget instead of growing dedup maps without bound', async () => {
  const f = await fixture();
  try {
    await f.start();
    for (let index = 0; index < 110; index++) {f.sdk.emit({ type: 'assistant', session_id: f.sdk.options.sessionId, agent_id: 'child-A', parent_tool_use_id: 'parent-tool', uuid: `empty-${index}`,
      message: { id: `empty-${index}`, content: [] } });}
    await setImmediate();
    assert.ok(f.events.some(event => event.kind === 'diagnostic' && event.code === 'output-limit'));
    assert.deepEqual(await f.session.checkReadiness(), { ok: false, code: 'output-limit' });
    denied(await invoke(f.hook, f.pre('Write', {}, 'child-A')));
  } finally { await f.close(); }
});


test('parent close aborts a pending child observer before waiting on the native iterator', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async fact => { if (fact.phase === 'started') {await held;} });
  try {
    await f.start();
    const close = f.close();
    const receipt = await Promise.race([close, new Promise<never>((_resolve, reject) => { setTimeout(() => reject(new Error('Parent close stuck on observer')), 1000); })]);
    assert.deepEqual(receipt, { logicallyClosed: true, cleanup: 'confirmed' });
    assert.equal(f.facts[0]?.signal.aborted, true); assert.deepEqual(f.sdk.stopped, ['child-A']);
    release(); await setImmediate(); assert.equal(f.facts.length, 1);
  } finally { release(); await f.close(); }
});


test('original-input authorization denies DO policy loss and cannot outlive parent interruption', async () => {
  let release!: () => void; const held = new Promise<boolean>(resolve => { release = () => resolve(true); });
  let selected: ClaudeSubagentAuthorization | undefined;
  const f = await fixture(undefined, async request => { selected = request; return held; });
  try {
    await f.start(false);
    const pending = invoke(f.hook, f.parent()); await setImmediate();
    assert.equal(selected?.sessionRef, f.config.sessionRef); assert.equal(selected?.inputId, 'input-A'); assert.equal(selected?.operationRef, 'operation-A'); assert.equal(selected?.parentToolRef, 'parent-tool');
    assert.ok((await f.session.interrupt('operation-A')).ok);
    denied(await pending); assert.equal(selected?.signal.aborted, true);
    release(); await setImmediate(); assert.equal(f.facts.length, 0);
  } finally { release(); await f.close(); }
  const deniedMode = await fixture(undefined, async () => false);
  try { await deniedMode.start(false); denied(await invoke(deniedMode.hook, deniedMode.parent())); assert.equal(deniedMode.facts.length, 0); }
  finally { await deniedMode.close(); }
});
