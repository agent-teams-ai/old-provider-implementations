import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CodexAppServerClient } from '../../../../src/codex.ts';
import { context, input, ref } from './driver-support.ts';
import { fixture } from './subprocess-fixture.ts';

const required = () => ({ 'TEST-server': ['look-up.raw'] });

test('native mandatory MCP readiness uses actual owned thread/server/raw tool names before handoff', async t => {
  const f = await context(t); const floor = required(); Object.assign(f.config, { requiredMcpTools: floor });
  const { driver } = await f.factory.open(f.request); t.after(() => driver.close());
  floor['TEST-server'].push('later-mutation');
  assert.equal((await driver.checkReadiness()).ok, true);
  const status = f.native.writes.filter(frame => frame.method === 'mcpServerStatus/list'); assert.equal(status.length, 2);
  assert.deepEqual(status[0]!.params, { threadId: 'thread-1', serverName: 'TEST-server', limit: 100, detail: 'toolsAndAuthOnly' });
  assert.equal(f.native.writes.some(frame => frame.method === 'turn/start'), false);
  assert.equal((await driver.submit(input())).ok, true);
  const methods = f.native.writes.map(frame => frame.method); assert.ok(methods.lastIndexOf('mcpServerStatus/list') < methods.indexOf('turn/start'));
  await f.native.command({ kind: 'finish', ...ref(f.native) });
});

test('MCP catalog pagination and pending native startup are bounded read-only checks', async t => {
  for (const mode of ['pagination', 'pending']) {
    const f = await context(t); Object.assign(f.config, { requiredMcpTools: required() });
    await f.native.command({ kind: 'mcp-status', mode });
    const { driver } = await f.factory.open(f.request); await driver.close();
    const pages = f.native.writes.filter(frame => frame.method === 'mcpServerStatus/list'); assert.equal(pages.length, 2);
    if (mode === 'pagination') { assert.deepEqual(pages[1]!.params, { threadId: 'thread-1', serverName: 'TEST-server', cursor: 'TEST-next', limit: 100, detail: 'toolsAndAuthOnly' }); }
    assert.equal(f.native.writes.some(frame => frame.method === 'turn/start'), false);
  }
});

for (const mode of ['wrong-tools', 'wrong-tool-name', 'wrong-server', 'disconnected', 'tools-error', 'cached-only', 'malformed', 'duplicate-cursor', 'excessive-pages', 'timeout']) {
  test('mandatory native MCP refuses ' + mode + ' before work even when Host probe reports healthy', async t => {
    const f = await context(t); let hostProbes = 0;
    Object.assign(f.config, { requiredMcpTools: required(), limits: { ...f.config.limits, timeoutMs: mode === 'timeout' ? 100 : 2000 }, probe: async () => { hostProbes++; return true; } });
    await f.native.command({ kind: 'mcp-status', mode });
    await assert.rejects(f.factory.open(f.request), /codex.driver.dependency-unavailable/u);
    assert.equal(hostProbes, 0); assert.equal(f.native.writes.some(frame => frame.method === 'turn/start'), false);
    const pages = f.native.writes.filter(frame => frame.method === 'mcpServerStatus/list').length;
    assert.ok(pages <= 16); if (mode === 'duplicate-cursor') { assert.equal(pages, 2); }
  });
}

test('native tool floor is rechecked before each input and cannot be replaced by a healthy injected probe', async t => {
  const f = await context(t); Object.assign(f.config, { requiredMcpTools: required() });
  const { driver } = await f.factory.open(f.request); t.after(() => driver.close());
  await f.native.command({ kind: 'mcp-status', mode: 'wrong-tools' });
  assert.deepEqual(await driver.submit(input()), { ok: false, code: 'dependency-unavailable', delivery: 'known-not-sent' });
  assert.equal(f.native.writes.some(frame => frame.method === 'turn/start'), false);
});

test('omitted native tool floor preserves previous behavior and exact checkpoint compatibility bytes', async t => {
  const f = await context(t); await f.native.command({ kind: 'mcp-status', mode: 'wrong-tools' });
  const { driver } = await f.factory.open(f.request); t.after(() => driver.close());
  assert.equal(f.native.writes.some(frame => frame.method === 'mcpServerStatus/list'), false);
  const cp = driver.checkpoint(); assert.ok(cp.ok);
  const c = f.config, { tenantId, projectId, sessionId } = c.binding;
  const previous = createHash('sha256').update(JSON.stringify({ tenantId, projectId, sessionId, configRevision: c.configRevision,
    protocolRevision: c.protocolRevision, trustedBinding: c.trustedBinding, accountBinding: c.accountBinding, threadParams: c.threadParams, turnParams: {} })).digest('hex');
  assert.equal((cp.value as { compatibility: string }).compatibility, previous);
});

test('required native tool configuration snapshots, rejects malformed maps and binds checkpoint restore', async t => {
  const first = await context(t); Object.assign(first.config, { requiredMcpTools: required() });
  const { driver } = await first.factory.open(first.request);
  const cp = driver.checkpoint(); assert.ok(cp.ok); await driver.close();
  const next = await context(t); next.checkpoint(cp.value); Object.assign(next.config, { requiredMcpTools: { 'TEST-server': ['different'] } });
  await assert.rejects(next.factory.open({ ...next.request, checkpointRef: 'TEST-selected' }), /checkpoint-incompatible/u);
  assert.equal(next.native.writes.length, 0);
  for (const bad of [null, [], Object.create({ server: ['look-up.raw'] }), { '': ['tool'] }, { server: [] }, { server: ['same', 'same'] }, { server: [42] }]) {
    const item = await context(t); Object.assign(item.config, { requiredMcpTools: bad });
    await assert.rejects(item.factory.open(item.request), /invalid-config/u); assert.equal(item.native.writes.length, 0);
  }
});

test('finite native client discovery rejects foreign/released thread and captures request before await', async t => {
  const native = await fixture(t);
  const client = new CodexAppServerClient({ transport: native.transport, onEvent() {}, requestApproval: async () => ({ kind: 'decision', decision: 'decline' }) });
  t.after(() => client.close());
  await client.initialize({ clientInfo: { name: 'TEST-client', version: '0.0.0' }, capabilities: { experimentalApi: true } });
  const thread = await client.startThread({ cwd: '/TEST-unused', model: 'TEST-model' });
  await assert.rejects(client.listMcpServerStatus({ threadId: 'foreign', serverName: 'TEST-server' }), /unbound-mcp-thread/u);
  for (const request of [{ threadId: thread.threadId, serverName: '' }, { threadId: thread.threadId, serverName: 'TEST-server', cursor: '' }, { threadId: thread.threadId, serverName: 'TEST-server', limit: 0 }]) {
    await assert.rejects(client.listMcpServerStatus(request), /invalid-mcp-status-request/u);
  }
  assert.equal(native.writes.some(frame => frame.method === 'mcpServerStatus/list'), false);
  const request = { threadId: thread.threadId, serverName: 'TEST-server' };
  const page = client.listMcpServerStatus(request); request.serverName = 'later-mutation';
  assert.equal((await page).data[0]?.name, 'TEST-server');
  client.releaseThread(thread.threadId);
  await assert.rejects(client.listMcpServerStatus({ threadId: thread.threadId, serverName: 'TEST-server' }), /unbound-mcp-thread/u);
  assert.equal(native.writes.filter(frame => frame.method === 'mcpServerStatus/list').length, 1);
});
