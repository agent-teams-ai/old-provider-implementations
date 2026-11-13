import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { Event } from '@agent-teams/provider-session-contracts';
import { createClaudeDriverFactory } from '../../../../src/claude.ts';
import { captureClaudeCommands, claudeCommandName, resolveClaudeCommand } from '../../../../src/features/provider-session-implementation/adapters/claude-sdk/commands.ts';
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
