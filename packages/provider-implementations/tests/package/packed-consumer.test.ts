import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { installPackedConsumer, retainCheckedArchive, runConsumer } from './install-consumer.ts'

test('packed consumer imports codecs and declarations without donor checkout or private paths', async t => {
  const root = process.cwd()
  const sandbox = await mkdtemp(join(tmpdir(), 'TEST-provider-packed-'))
  t.after(() => rm(sandbox, { recursive: true, force: true }))
  const { archive, packageDir } = await installPackedConsumer(root, sandbox)
  const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
  assert.ok(!files.split('\n').some(path => /^package\/(?:src|tests|node_modules)\//u.test(path)))
  const consumer = `import { CodexAppServerClient, createCodexDriverFactory, mapCodexNativeExecLine } from '@agent-teams/provider-implementations/codex';
import type { CodexDriverConfig, CodexDriverHost } from '@agent-teams/provider-implementations/codex';
import { createClaudeDriverFactory, openClaudeSession, readClaudeMetadata, probeClaudeModel } from '@agent-teams/provider-implementations/claude';
import { EventFeed } from '@agent-teams/provider-implementations/session-io';
import type { DriverFactory, Session, EventPayload, Input } from '@agent-teams/provider-session-contracts';
import type { ClaudeConfig, ClaudeDriverHost } from '@agent-teams/provider-implementations/claude';
const mandatoryTools: CodexDriverConfig['requiredMcpTools'] = { team: ['look-up.raw'] };
const finiteStatusMethod: CodexAppServerClient['listMcpServerStatus'] | undefined = undefined;
if (mandatoryTools.team?.[0] !== 'look-up.raw' || finiteStatusMethod !== undefined) throw Error('finite native MCP contracts');
const compaction: EventPayload = { kind: 'compaction', sourceRef: 'opaque', reason: 'automatic' };
const nativeOptions: ClaudeConfig['nativeOptions'] = { permissionMode: 'acceptEdits', settingSources: ['project'], projectInstructions: { append: 'TEST' }, effort: 'high', fastMode: false, context: 'model-default' };
const namespace: ClaudeConfig['configNamespace'] = 'native-default';
const attachmentRefs: Input['attachments'] = [{ artifactId: 'TEST-image', mimeType: 'image/png', byteLength: 1, digest: '0'.repeat(64) }];
const attachmentResolver: NonNullable<ClaudeConfig['attachments']> = { model: 'TEST-model', revision: 'TEST-policy', mimeTypes: ['image/png'], resolve: async binding => ({ binding, bytes: new Uint8Array([0]) }) };
if (attachmentRefs.length !== 1 || attachmentResolver.model !== 'TEST-model') throw Error('attachment contracts');
if (compaction.kind !== 'compaction' || nativeOptions.fastMode !== false || namespace !== 'native-default') throw Error('selected Claude contracts');
const factory: (host: ClaudeDriverHost) => DriverFactory = createClaudeDriverFactory;
const codexFactory: (host: CodexDriverHost) => DriverFactory = createCodexDriverFactory;
if (typeof codexFactory !== 'function') throw Error('Codex canonical adapter');
if (typeof factory !== 'function' || typeof openClaudeSession !== 'function' || typeof readClaudeMetadata !== 'function' || typeof probeClaudeModel !== 'function' || typeof EventFeed !== 'function') throw Error('provider API');
type ConsumerSession = Pick<Session, 'submit' | 'observe' | 'interrupt' | 'close'>;
export type { ConsumerSession };
import type { CodexApprovalReply, CodexNativeNormalizedEvent } from '@agent-teams/provider-implementations/codex';
import { createOpenCodeV1DriverFactory, createOpenCodeV2DriverFactory, isCanonicalOpenCodeAscendingMessageId } from '@agent-teams/provider-implementations/opencode';
import type { OpenCodeV1DriverHost, OpenCodeV2DriverHost } from '@agent-teams/provider-implementations/opencode';
const openCodeFactory: (host: OpenCodeV2DriverHost) => DriverFactory = createOpenCodeV2DriverFactory;
const openCodeV1Factory: (host: OpenCodeV1DriverHost) => DriverFactory = createOpenCodeV1DriverFactory;
if (typeof openCodeFactory !== 'function') throw Error('OpenCode canonical adapter');
if (typeof openCodeV1Factory !== 'function') throw Error('OpenCode V1 canonical adapter');
if (!isCanonicalOpenCodeAscendingMessageId('msg_00000000000100000000000000')) throw Error('OpenCode codec');
const unknownUsage: CodexNativeNormalizedEvent = { type: 'usage_updated' };
if (unknownUsage.inputTokens !== undefined) throw Error('unknown usage');
if (typeof CodexAppServerClient !== 'function') throw Error('app-server export');
const reply: CodexApprovalReply = { kind: 'decision', decision: 'decline' };
if (reply.decision !== 'decline' || mapCodexNativeExecLine('{"type":"thread.started","thread_id":"packed"}')[0]?.type !== 'thread_started') throw Error('codec');
await import('@agent-teams/provider-implementations/src/features/codex-protocol/exec-jsonl.js').then(() => {throw Error('private path exposed')}, e => {if(e.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw e});
`
  await writeFile(join(sandbox, 'consumer.ts'), consumer)
  execFileSync(process.execPath, ['consumer.ts'], { cwd: sandbox, stdio: 'pipe' })
  // Type consumer excludes the deliberate runtime-only forbidden import probe.
  await writeFile(join(sandbox, 'types.ts'), consumer.slice(0, consumer.indexOf('await import(')))
  await writeFile(join(sandbox, 'root-types.ts'), "import type { CodexNativeNormalizedEvent } from '@agent-teams/provider-implementations';\nexport type RootContract = CodexNativeNormalizedEvent;\n")
  await writeFile(join(sandbox, 'tsconfig.root.json'), JSON.stringify({ compilerOptions: { strict: true, types: [], lib: ['ES2024'], module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true }, files: ['root-types.ts'] }))
  runConsumer(['exec', 'tsc', '--project', 'tsconfig.root.json'], sandbox)
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', "console.log(JSON.stringify(Object.keys(await import('@agent-teams/provider-implementations'))))"], { cwd: sandbox, encoding: 'utf8' })), [])
  // Run the packed app-server implementation across an actual synthetic subprocess boundary.
  await writeFile(join(sandbox, 'lifecycle.ts'), `
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CodexAppServerClient, createCodexDriverFactory } from '@agent-teams/provider-implementations/codex';
import type { CodexAppServerTransport } from '@agent-teams/provider-implementations/codex';
function native() {
const child = spawn(process.execPath, [process.argv[2]!], { cwd: process.cwd(), env: { HOME: process.cwd() }, stdio: ['pipe','pipe','pipe','ipc'] });
const { stdin, stdout } = child;
if (!stdin || !stdout) throw Error('fixture pipes');
const transport: CodexAppServerTransport = {
  async *read(signal) {
    const abort = () => { stdout.destroy(); };
    signal.addEventListener('abort', abort, { once: true });
    try { for await (const chunk of stdout) yield chunk; }
    finally { signal.removeEventListener('abort', abort); }
  },
  write(frame) { return new Promise<void>((yes, no) => stdin.write(frame, error => error ? no(error) : yes())); }
};
return { child, transport };
}
const original = native();
const client = new CodexAppServerClient({ transport: original.transport, onEvent() {}, async requestApproval() { return { kind: 'decision', decision: 'decline' }; } });
try {
  await client.initialize({ clientInfo: { name: 'packed-consumer', version: '0' } });
  assert.equal(typeof client.getRuntimeIdentity().codexHome, 'string');
  await new Promise<void>(resolve => { const ack = (value: unknown) => { if ((value as { commandId?: string }).commandId === 'metadata') { original.child.off('message', ack); resolve(); } }; original.child.on('message', ack); original.child.send({ kind: 'metadata', method: 'account/read', response: { account: null, requiresOpenaiAuth: true }, id: 'metadata' }); });
  assert.deepEqual(await client.readAccount(), { account: null, requiresOpenaiAuth: true });
  const session = await client.resumeThread('packed-native-thread');
  const submission = session.submitTurn({ input: [{ type: 'text', text: 'packed' }] });
  const ref = await submission.accepted;
  original.child.send({ kind: 'finish', ...ref, id: 'packed' });
  assert.deepEqual(await submission.completed, { ...ref, outcome: 'completed' });
} finally { client.close(); original.child.kill('SIGTERM'); }
const canonical = native();
const request = { tenantId: 'TEST-tenant', projectId: 'TEST-project', sessionId: 'packed-runtime-session', generation: 1, configRevision: 'TEST-config', requiredCapabilities: ['text', 'checkpoint'] };
const factory = createCodexDriverFactory({ capabilities: ['text', 'checkpoint'], async readCheckpoint() { return undefined; }, async resolveConfiguration() { return {
  binding: request, configRevision: request.configRevision, protocolRevision: 'TEST-native', accountBinding: 'TEST-account', trustedBinding: 'TEST-binding',
  transport: canonical.transport, initialize: { clientInfo: { name: 'packed-consumer', version: '0' } }, threadParams: {},
  limits: { queuedInputs: 1, inputBytes: 4096, outputBytes: 8192, outputEvents: 20, pendingInteractions: 1, timeoutMs: 2000 },
  async probe() { return true; }, async confirmStopped() { return false; }
}; } });
let driver: import('@agent-teams/provider-session-contracts').Session | undefined;
try {
  ({ driver } = await factory.open(request));
  const completed = (async () => { for await (const event of driver!.observe()) if (event.kind === 'result') return event; throw Error('missing terminal'); })();
  assert.deepEqual(await driver.submit({ inputId: 'input', operationRef: 'operation', content: 'packed' }), { ok: true, value: { inputId: 'input', operationRef: 'operation', delivery: 'client-consumed', providerAcceptance: 'unknown' } });
  canonical.child.send({ kind: 'finish', threadId: 'thread-1', turnId: 'turn-1', id: 'packed' });
  assert.deepEqual(await completed, { kind: 'result', outcome: 'succeeded', sessionRef: request.sessionId, inputId: 'input', operationRef: 'operation' });
  const checkpoint = driver.checkpoint(); assert(checkpoint.ok);
  assert.equal((checkpoint.value as Record<string, unknown>).nativeThreadId, 'thread-1');
} finally { await driver?.close(); canonical.child.kill('SIGTERM'); }
`)
  runConsumer(['exec', 'tsc', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2024', '--noEmit', '--strict', '--types', 'node', 'types.ts', 'lifecycle.ts'], sandbox)
  execFileSync(process.execPath, ['lifecycle.ts', resolve(root, 'tests/fixtures/codex-app-server.ts')], { cwd: sandbox, stdio: 'pipe', timeout: 10000 })
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.engines, { node: '>=24.21.0 <25 || >=26.11.1 <27' })
  assert.deepEqual(manifest.dependencies, { '@anthropic-ai/claude-agent-sdk': '0.3.305', zod: '4.6.7', '@anthropic-ai/sdk': '0.122.0', '@modelcontextprotocol/sdk': '1.30.0', '@agent-teams/provider-session-contracts': '0.0.0' })
  assert.equal(manifest.peerDependencies, undefined)
  const lock = await readFile(join(sandbox, 'pnpm-lock.yaml'), 'utf8')
  assert.ok(!lock.includes('link:'))
  if (process.env.AGENT_TEAMS_PROVIDER_PACK_TEST_RETAIN_DIR) {console.log(JSON.stringify(await retainCheckedArchive(archive, process.env.AGENT_TEAMS_PROVIDER_PACK_TEST_RETAIN_DIR)))}
})
