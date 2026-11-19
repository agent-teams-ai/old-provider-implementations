import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { Event } from '@agent-teams/provider-session-contracts';
import { createClaudeDriverFactory } from '../../../../src/claude.ts';
import type { ClaudeConfig } from '../../../../src/claude.ts';
import { captureClaudeCommands, claudeCommandName, claudeLegacyReviewContent, projectClaudeCommands, resolveClaudeCommand } from '../../../../src/features/provider-session-implementation/adapters/claude-sdk/commands.ts';
import { configuration, QueryFixture, request } from './support.ts';

test('captured command metadata preserves exact name precedence without retaining mutable native objects', () => {
  const rows = [
    { name: 'usage', description: 'TEST native usage', argumentHint: '', builtin: true, aliases: ['cost'] },
    { name: 'review', description: 'TEST user skill', argumentHint: '<file>' },
    { name: 'review', description: 'TEST native review', argumentHint: '', builtin: true },
  ];
  const captured = captureClaudeCommands(rows);
  rows[0]!.aliases!.push('unqualified'); rows[1]!.name = 'changed';
  assert.deepEqual(resolveClaudeCommand(captured, 'cost')?.aliases, ['cost']);
  assert.equal(resolveClaudeCommand(captured, 'review')?.builtin, true);
  assert.equal(resolveClaudeCommand(captured, 'changed'), undefined);
  assert.equal(Object.isFrozen(captured), true);
  const exact = captureClaudeCommands([...rows, { name: 'cost', description: 'TEST exact custom name', argumentHint: '' }]);
  assert.equal(resolveClaudeCommand(exact, 'cost')?.builtin, undefined, 'an exact name wins over another command alias');
  assert.deepEqual(captureClaudeCommands([{ name: 'unsafe/path', description: '', argumentHint: '' }]), []);
  assert.deepEqual(captureClaudeCommands(Array.from({ length: 2049 }, () => rows[0])), []);
});

test('actual SDK 0.3.305 private metadata does not hide the captured public commands', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/commands-0.3.305.json', import.meta.url), 'utf8')) as {
    sdkVersion: string; sdkSha256: string; catalogSha256: string; commands: unknown[];
  };
  assert.equal(fixture.sdkVersion, '0.3.305');
  assert.equal(fixture.sdkSha256, 'c8d3e6cf794501c9b2dad3199762e4594e7b890e8ce76f957e9d748e02680bb1');
  assert.equal(createHash('sha256').update(JSON.stringify(fixture.commands)).digest('hex'), fixture.catalogSha256);
  assert.equal(fixture.commands.length, 46);
  const captured = captureClaudeCommands(fixture.commands);
  assert.equal(captured.length, 45);
  for (const [supplied, canonical] of [
    ['compact', 'compact'], ['cost', 'usage'], ['review', 'code-review'],
    ['test-user-command', 'test-user-command'], ['test-project-command', 'test-project-command'],
  ]) assert.equal(resolveClaudeCommand(captured, supplied!)?.name, canonical);
  assert.equal(resolveClaudeCommand(captured, '__remote-workflow'), undefined);
  assert.equal(claudeCommandName('/__remote-workflow'), undefined, 'private names gain no raw dispatch grammar');
  assert.equal(Object.isFrozen(captured), true);
  const selected = resolveClaudeCommand(captured, 'review'); assert.ok(selected);
  assert.equal(Object.hasOwn(selected, 'compatibility'), false);
  assert.equal(resolveClaudeCommand(projectClaudeCommands(captured), 'review')?.compatibility?.execution, 'legacy-inline-review-v1');
  const forged = captureClaudeCommands([{ ...selected, builtin: false, compatibility: { invocation: 'review', execution: 'legacy-inline-review-v1' } }]);
  assert.equal(Object.hasOwn(forged[0]!, 'compatibility'), false);
  assert.equal(claudeLegacyReviewContent('/review', forged[0]), undefined);
});

test('qualified review alias uses one legacy inline input with original permissions, owner and bounded handoff', async () => {
  const sdk = new QueryFixture();
  const native = { name: 'code-review', description: 'TEST original fork command', argumentHint: 'TEST native flags', aliases: ['review'], builtin: true };
  const initial = [native];
  const observations: unknown[] = [];
  const boundary = { ...sdk.boundary, query: (args: Parameters<typeof sdk.boundary.query>[0]) => {
    sdk.boundary.query(args);
    return Object.assign(sdk, { supportedCommands: async () => initial });
  } };
  const config: ClaudeConfig = { ...configuration(), limits: { ...configuration().limits, inputBytes: 4096 },
    nativeOptions: { permissionMode: 'default', settingSources: ['user', 'project', 'local'] },
    observeCommands: (commands: unknown) => { observations.push(commands); } };
  const opened = await createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => config,
    readCheckpoint: async () => { throw new Error('fresh'); } }, boundary).open(request);
  const events: Event[] = [];
  const observing = (async () => { for await (const event of opened.driver.observe()) { events.push(event); } })();
  const finish = async (index: number) => {
    sdk.emit({ type: 'result', subtype: 'success', session_id: sdk.options.sessionId, uuid: `TEST-result-${index}`,
      user_message_uuid: sdk.inputs[index]?.uuid, result: 'TEST completed main review', is_error: false });
    await setImmediate();
  };
  try {
    const original = { inputId: 'review-input', operationRef: 'review-operation', content: ' \n/review  123  --literal \n' };
    assert.deepEqual(await opened.driver.submit(original), { ok: true, value: { inputId: original.inputId,
      operationRef: original.operationRef, delivery: 'client-consumed', providerAcceptance: 'unknown' } });
    await setImmediate();
    assert.equal(sdk.inputs.length, 1); assert.equal(sdk.calls, 1);
    const wire = sdk.inputs[0]!;
    assert.equal(typeof wire.message.content, 'string');
    assert.ok(String(wire.message.content).startsWith('\n      You are an expert code reviewer. Follow these steps:'));
    assert.ok(String(wire.message.content).endsWith('\n      PR number:  123  --literal\n    '));
    assert.equal(original.content, ' \n/review  123  --literal \n', 'raw caller input remains unchanged');
    assert.equal(wire.parent_tool_use_id, null); assert.ok(wire.uuid);
    assert.equal(sdk.options.permissionMode, 'default');
    assert.deepEqual(sdk.options.settingSources, ['user', 'project', 'local']);
    assert.deepEqual(observations[0], [{ ...native, compatibility: { invocation: 'review', execution: 'legacy-inline-review-v1',
      description: 'Review a pull request in the current conversation.', argumentHint: '[pr number]' } }]);
    assert.equal(Object.hasOwn(native, 'compatibility'), false, 'the native inventory is never rewritten');
    const canUseTool = sdk.options.canUseTool; assert.ok(canUseTool);
    const input = { file_path: '/TEST-unused/review.txt' };
    const permission = canUseTool('Read', input, { signal: new AbortController().signal, toolUseID: 'TEST-review-read', requestId: 'TEST-review-request' });
    await setImmediate();
    const interaction = events.find(event => event.kind === 'interaction'); assert.ok(interaction?.kind === 'interaction');
    assert.equal(interaction.inputId, original.inputId); assert.equal(interaction.operationRef, original.operationRef);
    assert.deepEqual(interaction.request, { kind: 'permission', tool: 'Read', input });
    assert.deepEqual(opened.driver.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: true, value: undefined });
    assert.deepEqual(await permission, { behavior: 'allow', updatedInput: input });
    assert.deepEqual(opened.driver.respondToInteraction(interaction.interactionRef, { kind: 'permission', decision: 'allow' }), { ok: false, code: 'stale' });
    assert.equal(events.some(event => event.kind === 'result'), false);
    await finish(0);
    assert.equal(events.some(event => event.kind === 'result' && event.inputId === original.inputId &&
      event.operationRef === original.operationRef && event.outcome === 'succeeded'), true);
    assert.equal(events.some(event => event.kind === 'text' && event.messageRef.startsWith('local-command:')), false);
    assert.deepEqual(await opened.driver.submit({ inputId: 'large-review', operationRef: 'large-review-operation', content: `/review ${'x'.repeat(3500)}` }),
      { ok: false, code: 'backpressure', delivery: 'known-not-sent' });
    assert.equal(sdk.inputs.length, 1, 'expanded wire limit is checked before handoff');
    for (const content of ['/code-review 123', '/review\t123']) {
      const index: number = sdk.inputs.length;
      assert.equal((await opened.driver.submit({ inputId: `native-${index}`, operationRef: `native-operation-${index}`, content })).ok, true);
      await setImmediate(); assert.equal(sdk.inputs[index]?.message.content, content); await finish(index);
    }
    initial.push({ name: 'review', description: 'TEST exact custom command', argumentHint: '<file>', aliases: [], builtin: false });
    const index = sdk.inputs.length, content = '/review TEST-custom';
    assert.equal((await opened.driver.submit({ inputId: 'custom-review', operationRef: 'custom-review-operation', content })).ok, true);
    await setImmediate(); assert.equal(sdk.inputs[index]?.message.content, content);
    assert.deepEqual(observations.at(-1), initial.map(({ builtin, ...row }) => ({ ...row, ...(builtin ? { builtin } : {}) })));
    await finish(index);
  } finally { assert.equal((await opened.driver.close()).cleanup, 'confirmed'); await observing; }
});

test('same Query command changes and local result require native session and original echoed user UUID', async () => {
  const sdk = new QueryFixture();
  const initial = [{ name: 'usage', description: 'TEST usage', argumentHint: '', aliases: ['cost'], builtin: true }];
  const observations: unknown[] = [];
  const boundary = { ...sdk.boundary, query: (args: Parameters<typeof sdk.boundary.query>[0]) => {
    sdk.boundary.query(args);
    return Object.assign(sdk, { supportedCommands: async () => initial });
  } };
  const config = { ...configuration(), observeCommands: (commands: unknown) => { observations.push(commands); } };
  const opened = await createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => config,
    readCheckpoint: async () => { throw new Error('fresh'); } }, boundary).open(request);
  const events: Event[] = [];
  const observing = (async () => { for await (const event of opened.driver.observe()) { events.push(event); } })();
  try {
    assert.deepEqual(observations[0], initial);
    assert.equal((await opened.driver.submit({ inputId: 'cost-input', operationRef: 'cost-operation', content: '/cost' })).ok, true);
    await setImmediate();
    const session_id = sdk.options.sessionId;
    sdk.emit({ type: 'system', subtype: 'local_command_output', session_id, uuid: 'unbound', content: 'TEST unbound output' });
    sdk.emit({ type: 'assistant', session_id, parent_tool_use_id: null, user_message_uuid: sdk.inputs[0]?.uuid,
      message: { id: 'local-command:forged-native-id', content: [{ type: 'text', text: 'not a local result' }] } });
    sdk.emit({ type: 'system', subtype: 'commands_changed', session_id, agent_id: 'child', commands: [] });
    sdk.emit({ type: 'system', subtype: 'commands_changed', session_id, commands: [] });
    sdk.emit({ type: 'result', subtype: 'success', session_id, uuid: 'cost-result', user_message_uuid: sdk.inputs[0]?.uuid,
      local_command: 'usage', result: 'TEST actual subscription output', is_error: false });
    await setImmediate();
    assert.deepEqual(observations.at(-1), []);
    assert.deepEqual(events.filter(event => event.kind === 'text').map(event => ({ ...event, sessionRef: 'captured' })), [{
      sessionRef: 'captured', inputId: 'cost-input', operationRef: 'cost-operation', kind: 'text',
      messageRef: 'local-command:cost-result', block: 0, text: 'TEST actual subscription output', phase: 'complete',
    }]);
    assert.equal(events.some(event => event.kind === 'result' && event.inputId === 'cost-input' && event.outcome === 'succeeded'), true);
    assert.equal((await opened.driver.submit({ inputId: 'ordinary-input', operationRef: 'ordinary-operation', content: 'TEST ordinary turn' })).ok, true);
    await setImmediate();
    sdk.emit({ type: 'result', subtype: 'success', session_id, uuid: 'ordinary-result', user_message_uuid: sdk.inputs[1]?.uuid,
      local_command: 'cost', result: 'must not become a command result', is_error: false });
    await setImmediate();
    assert.equal(events.filter(event => event.kind === 'text').length, 1);
    const saved = initial.splice(0);
    assert.deepEqual(await opened.driver.submit({ inputId: 'removed-skill', operationRef: 'removed-skill-operation', content: '/cost' }),
      { ok: false, code: 'unsupported', delivery: 'known-not-sent' });
    assert.equal(sdk.inputs.length, 2, 'a removed native command cannot turn into an ordinary model prompt');
    initial.push(...saved);
    assert.equal((await opened.driver.submit({ inputId: 'foreign-input', operationRef: 'foreign-operation', content: '/cost' })).ok, true);
    await setImmediate();
    sdk.emit({ type: 'result', subtype: 'success', session_id, uuid: 'foreign-result', user_message_uuid: 'another-user-UUID',
      local_command: 'cost', result: 'must not bind to active cost', is_error: false });
    await setImmediate();
    assert.equal(events.filter(event => event.kind === 'text').length, 1);
    assert.equal(events.some(event => event.kind === 'result' && event.inputId === 'foreign-input' && event.outcome === 'succeeded'), false);
  } finally { assert.equal((await opened.driver.close()).cleanup, 'confirmed'); await observing; }
});
