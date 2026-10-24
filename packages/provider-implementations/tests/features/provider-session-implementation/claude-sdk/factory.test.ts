import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { DriverFactory, Event, OpenConfig } from '@agent-teams/provider-session-contracts';
import { createClaudeDriverFactory } from '../../../../src/claude.ts';
import { configuration, QueryFixture, request } from './support.ts';

test('canonical DriverFactory uses a pinned Host projection and preserves runtime input/operation ownership', async () => {
  const sdk = new QueryFixture();
  const capabilities = ['text', 'permission'];
  let observed: OpenConfig | undefined;
  const c = configuration();
  const factory: DriverFactory = createClaudeDriverFactory({
    capabilities,
    resolveConfiguration: async value => { observed = value; return c; },
    readCheckpoint: async () => { throw new Error('fresh open must not read checkpoint'); },
  }, sdk.boundary);
  capabilities.push('not-qualified');
  const opened = await factory.open(request);
  assert.deepEqual(opened.capabilities, ['text', 'permission']);
  assert.deepEqual(observed, request);
  assert.ok(Object.isFrozen(observed) && Object.isFrozen(observed?.requiredCapabilities));
  const events: Event[] = [];
  const observer = (async () => { for await (const event of opened.driver.observe()) { events.push(event); } })();
  try {
    c.model = 'later-mutation';
    const receipt = await opened.driver.submit({ inputId: 'input-1', operationRef: 'operation-1', content: 'test' });
    assert.deepEqual(receipt, { ok: true, value: { inputId: 'input-1', operationRef: 'operation-1', delivery: 'client-consumed', providerAcceptance: 'unknown' } });
    await setImmediate();
    assert.equal(sdk.options.model, 'fixture-model');
    sdk.emit({ type: 'result', subtype: 'success', session_id: sdk.options.sessionId, user_message_uuid: sdk.inputs[0]?.uuid });
    await setImmediate();
    assert.ok(events.some(event => event.kind === 'result' && event.outcome === 'succeeded' && event.inputId === 'input-1' && event.operationRef === 'operation-1'));
  } finally { assert.equal((await opened.driver.close()).cleanup, 'confirmed'); await observer; }
});

test('unsupported capability and mismatched configuration reject before query construction', async () => {
  const sdk = new QueryFixture();
  let resolutions = 0;
  let c = configuration();
  const factory = createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => { resolutions++; return c; }, readCheckpoint: async () => {} }, sdk.boundary);
  await assert.rejects(factory.open({ ...request, requiredCapabilities: ['unqualified'] }), /claude.driver.unsupported/u);
  assert.equal(resolutions, 0);
  for (const bad of [{ ...c, sessionRef: 'other-session' }, { ...c, configRevision: 'other-revision' }]) {
    c = bad;
    await assert.rejects(factory.open(request), /claude.driver.invalid-config/u);
  }
  assert.equal(sdk.calls, 0);
});

test('restore reads only an explicit checkpoint reference and never falls back to a fresh native session', async () => {
  const sdk = new QueryFixture();
  let checkpoint: unknown;
  const reads: string[] = [];
  const factory = createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => configuration(), readCheckpoint: async reference => { reads.push(reference); return checkpoint; } }, sdk.boundary);
  await assert.rejects(factory.open({ ...request, checkpointRef: 'missing' }), /claude.driver.checkpoint-missing/u);
  assert.equal(sdk.calls, 0);
  const first = await factory.open(request);
  const cp = first.driver.checkpoint(); assert.ok(cp.ok);
  checkpoint = cp.value;
  const native = sdk.options.sessionId;
  await first.driver.close();
  // A new physical SDK iterator represents the caller-owned recovered execution.
  const restoredSdk = new QueryFixture();
  const restored = await createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => configuration(), readCheckpoint: async reference => { reads.push(reference); return checkpoint; } }, restoredSdk.boundary).open({ ...request, generation: 2, checkpointRef: 'original' });
  try {
    assert.equal(restoredSdk.options.resume, native);
    assert.equal(restoredSdk.options.sessionId, undefined);
    assert.deepEqual(reads, ['missing', 'original']);
  } finally { await restored.driver.close(); }
});

test('native team message/registry tools cannot bypass the external product authority', async () => {
  const sdk = new QueryFixture();
  for (const nativeTool of ['SendMessage', 'ListAgents', 'TeamCreate', 'TaskUpdate', 'Agent']) {
    const c = configuration(); c.nativeTools = [nativeTool];
    const factory = createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => c, readCheckpoint: async () => {} }, sdk.boundary);
    await assert.rejects(factory.open(request), /claude.driver.invalid-config/u);
  }
  assert.equal(sdk.calls, 0);
});

test('close during the awaited per-input readiness probe cannot release a late SDK handoff', async () => {
  const sdk = new QueryFixture(); const c = configuration();
  let finishProbe!: (healthy: boolean) => void; let probes = 0;
  const held = new Promise<boolean>(resolve => { finishProbe = resolve; });
  c.probe = () => { probes++; return probes === 1 ? Promise.resolve(true) : held; };
  const opened = await createClaudeDriverFactory({ capabilities: ['text'],
    resolveConfiguration: async () => c, readCheckpoint: async () => {},
  }, sdk.boundary).open(request);
  try {
    const submission = opened.driver.submit({ inputId: 'held-input', operationRef: 'held-operation', content: 'TEST' });
    await setImmediate(); assert.equal(probes, 2);
    const closing = opened.driver.close(); finishProbe(true);
    assert.deepEqual(await submission, { ok: false, code: 'unknown' });
    assert.equal((await closing).cleanup, 'confirmed'); await setImmediate();
    assert.equal(sdk.inputs.length, 0);
  } finally { finishProbe(false); await opened.driver.close(); }
});


test('selected trusted native configuration is forwarded, snapshotted and checked at initialization', async () => {
  const sdk = new QueryFixture(); const c = configuration();
  c.configNamespace = 'native-default'; delete c.environment.CLAUDE_CONFIG_DIR;
  c.nativeOptions = { permissionMode: 'acceptEdits', settingSources: ['user', 'project'],
    projectInstructions: { append: 'TEST trusted instructions' }, effort: 'high', fastMode: false, context: 'one-million' };
  const opened = await createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => c, readCheckpoint: async () => {} }, sdk.boundary).open(request);
  try {
    c.nativeOptions.settingSources?.push('local'); c.nativeOptions.projectInstructions!.append = 'mutated';
    assert.equal(sdk.options.permissionMode, 'acceptEdits');
    assert.deepEqual(sdk.options.settingSources, ['user', 'project']);
    assert.deepEqual(sdk.options.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'TEST trusted instructions' });
    assert.equal(sdk.options.effort, 'high'); assert.deepEqual(sdk.options.settings, { fastMode: false });
    assert.deepEqual(sdk.options.betas, ['context-1m-2025-08-07']);
    assert.equal(Object.hasOwn(sdk.options.env ?? {}, 'CLAUDE_CONFIG_DIR'), false);
    assert.equal(sdk.options.env?.HOME, '/TEST-unused/home');
    assert.equal(sdk.options.strictMcpConfig, true); assert.deepEqual(sdk.options.tools, c.nativeTools);
    sdk.emit({ type: 'system', subtype: 'init', session_id: sdk.options.sessionId, permissionMode: 'acceptEdits' });
    await setImmediate();
    assert.equal((await opened.driver.submit({ inputId: 'selected', operationRef: 'selected', content: 'TEST' })).ok, true);
  } finally { await opened.driver.close(); }
});

test('default native configuration remains isolated and unoverridden', async () => {
  const sdk = new QueryFixture();
  const opened = await createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => configuration(), readCheckpoint: async () => {} }, sdk.boundary).open(request);
  try {
    assert.equal(sdk.options.permissionMode, 'default'); assert.deepEqual(sdk.options.settingSources, []);
    for (const key of ['settings', 'systemPrompt', 'effort', 'betas', 'allowDangerouslySkipPermissions']) { assert.equal(Object.hasOwn(sdk.options, key), false); }
    assert.equal(sdk.options.env?.CLAUDE_CONFIG_DIR, '/TEST-unused/config');
  } finally { await opened.driver.close(); }
});

test('invalid namespace, permission escalation and arbitrary native bags reject before constructing SDK', async () => {
  const sdk = new QueryFixture();
  const invalid = [
    { nativeOptions: { permissionMode: 'bypassPermissions' } },
    { nativeOptions: { settings: { hooks: {} } } },
    { nativeOptions: { hooks: {} } },
    { nativeOptions: { projectInstructions: { arbitrary: true } } },
    { nativeOptions: { effort: 'unknown' } },
    { nativeOptions: { settingSources: ['unknown'] } },
    { configNamespace: 'native-default' },
    { configNamespace: 'ambient' },
    { environment: { HOME: '/TEST-home', PATH: '/bin' } },
  ];
  for (const change of invalid) {
    const c = { ...configuration(), ...change } as ReturnType<typeof configuration>;
    await assert.rejects(createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => c, readCheckpoint: async () => {} }, sdk.boundary).open(request), /invalid-config/u);
  }
  assert.equal(sdk.calls, 0);
});

test('effective selected config changes reject checkpoint restore without constructing SDK', async () => {
  const sdk = new QueryFixture(); const c = configuration();
  c.nativeOptions = { permissionMode: 'plan', fastMode: true };
  const first = await createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => c, readCheckpoint: async () => {} }, sdk.boundary).open(request);
  const cp = first.driver.checkpoint(); assert.ok(cp.ok); await first.driver.close();
  for (const nativeOptions of [{ permissionMode: 'default' as const, fastMode: true }, { permissionMode: 'plan' as const, fastMode: false }, { permissionMode: 'plan' as const, fastMode: true, effort: 'high' as const }]) {
    const next = new QueryFixture();
    await assert.rejects(createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => ({ ...c, nativeOptions }), readCheckpoint: async () => cp.value }, next.boundary).open({ ...request, generation: 2, checkpointRef: 'TEST' }), /checkpoint-incompatible/u);
    assert.equal(next.calls, 0);
  }
});

test('compaction remains session scoped without a native input echo, deduplicates across turns and ignores child boundaries', async () => {
  const sdk = new QueryFixture();
  const opened = await createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => configuration(), readCheckpoint: async () => {} }, sdk.boundary).open(request);
  const events: Event[] = []; const observer = (async () => { for await (const event of opened.driver.observe()) { events.push(event); } })();
  try {
    await opened.driver.submit({ inputId: 'one', operationRef: 'one', content: 'TEST' }); await setImmediate();
    const compact = { type: 'system', subtype: 'compact_boundary', uuid: 'boundary-one', session_id: sdk.options.sessionId, compact_metadata: { trigger: 'auto', pre_tokens: 190000 } };
    sdk.emit({ ...compact, agent_id: 'child' }); sdk.emit({ ...compact, parent_tool_use_id: 'child-tool' });
    sdk.emit(compact); sdk.emit({ ...compact, user_message_uuid: sdk.inputs[0]?.uuid });
    sdk.emit({ type: 'result', subtype: 'success', session_id: sdk.options.sessionId, user_message_uuid: sdk.inputs[0]?.uuid });
    await setImmediate();
    await opened.driver.submit({ inputId: 'two', operationRef: 'two', content: 'TEST' }); await setImmediate();
    sdk.emit(compact); sdk.emit({ ...compact, uuid: 'boundary-two', user_message_uuid: sdk.inputs[1]?.uuid });
    await setImmediate();
    const observations = events.filter(event => event.kind === 'compaction'); assert.equal(observations.length, 2);
    assert.equal(observations[0]?.sessionRef, request.sessionId); assert.equal(observations[0]?.operationRef, undefined);
    assert.equal(observations[1]?.operationRef, 'two'); assert.equal(observations[1]?.inputId, 'two');
  } finally { await opened.driver.close(); await observer; }
});


test('explicit permission opt-in forwards only selected options and cannot replace the mandatory tool hook', async () => {
  const sdk = new QueryFixture(); const c = configuration();
  c.nativeOptions = { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, settingSources: [], effort: 'low', fastMode: true, context: 'model-default' };
  c.toolBinding = { matchedToolNames: ['mcp__TEST__write'], prepare: async () => { throw new Error('must not run without tool ownership'); } };
  const opened = await createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => c, readCheckpoint: async () => {} }, sdk.boundary).open(request);
  try {
    assert.equal(sdk.options.permissionMode, 'bypassPermissions'); assert.equal(sdk.options.allowDangerouslySkipPermissions, true);
    assert.equal(sdk.options.effort, 'low'); assert.deepEqual(sdk.options.settings, { fastMode: true });
    assert.equal(sdk.options.betas, undefined); assert.equal(sdk.options.model, c.model);
    assert.equal(sdk.options.hooks?.PreToolUse?.[0]?.hooks.length, 1);
    assert.equal(typeof sdk.options.canUseTool, 'function');
    sdk.emit({ type: 'system', subtype: 'init', session_id: sdk.options.sessionId, permissionMode: 'default' });
    await setImmediate();
    assert.deepEqual(await opened.driver.submit({ inputId: 'TEST', operationRef: 'TEST', content: 'TEST' }), { ok: false, code: 'unsupported' });
  } finally { await opened.driver.close(); }
});

test('native-default checkpoints bind the captured HOME and explicit namespace', async () => {
  const sdk = new QueryFixture(); const c = configuration(); c.configNamespace = 'native-default'; delete c.environment.CLAUDE_CONFIG_DIR;
  const opened = await createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => c, readCheckpoint: async () => {} }, sdk.boundary).open(request);
  const cp = opened.driver.checkpoint(); assert.ok(cp.ok); await opened.driver.close();
  for (const changed of [{ ...c, environment: { ...c.environment, HOME: '/TEST-other-home' } }, { ...configuration(), configNamespace: 'custom-directory' as const }]) {
    const next = new QueryFixture();
    await assert.rejects(createClaudeDriverFactory({ capabilities: ['text'], resolveConfiguration: async () => changed, readCheckpoint: async () => cp.value }, next.boundary).open({ ...request, generation: 2, checkpointRef: 'TEST' }), /checkpoint-incompatible/u);
    assert.equal(next.calls, 0);
  }
});
