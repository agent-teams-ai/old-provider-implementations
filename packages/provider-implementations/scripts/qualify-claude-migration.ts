import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseSync, Visitor } from 'oxc-parser';
import { installPackedConsumer, retainCheckedArchive, runConsumer } from '../tests/package/install-consumer.ts';

const revision = 'c9740b35a433ba370ed473a8dbfba27f3d902bbd';
const donor = process.argv[2];
assert.ok(donor, 'pass the read-only donor repository path; no ambient project is selected');
const sandbox = await mkdtemp(join(tmpdir(), 'TEST-claude-migration-'));
const files = [
  'test/session.test.ts', 'test/failures.test.ts', 'test/support.ts',
  'test/sdk-process.e2e.test.ts', 'harness/local-anthropic-fixture.ts',
];
function awaitInteractionReplies(source: string, path: string): string {
  const parsed = parseSync(path, source); assert.equal(parsed.errors.length, 0);
  const spans: { start: number; end: number }[] = [];
  new Visitor({ CallExpression(node) {
    if (node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.type === 'Identifier' && node.callee.property.name === 'respondToInteraction') {
      spans.push({ start: node.start, end: node.end });
    }
  } }).visit(parsed.program);
  for (const span of spans.toSorted((left, right) => right.start - left.start)) {
    source = source.slice(0, span.start) + '(await ' + source.slice(span.start, span.end) + ')' + source.slice(span.end);
  }
  return source;
}
try {
  const installed = await installPackedConsumer(process.cwd(), sandbox);
  for (const path of files) {
    const source: string = execFileSync('git', ['show', `${revision}:experiments/interactive-provider-contract/${path}`], { cwd: resolve(donor), encoding: 'utf8' });
    // Only qualification fixtures are staged. No donor production algorithm enters this consumer.
    let adapted: string = source.replaceAll('../src/claude/index.ts', '@agent-teams/provider-implementations/claude')
      .replaceAll('../src/draft-contracts/index.ts', '@agent-teams/provider-session-contracts');
    // C makes the input contract readonly; only the test-owned builder remains mutable.
    if (path === 'test/support.ts') {
      const builder = "export function config(ref = 'runtime-session-A'): ClaudeConfig {";
      assert.ok(adapted.includes(builder));
      adapted = adapted.replace(builder, "type FixtureConfig = Omit<ClaudeConfig, 'limits'> & { limits: { -readonly [K in keyof ClaudeConfig['limits']]: ClaudeConfig['limits'][K] } };\nexport function config(ref = 'runtime-session-A'): FixtureConfig {");
    }
    if (path === 'test/sdk-process.e2e.test.ts') {
      assert.ok(adapted.includes('const handle = query(args);'));
      adapted = adapted.replace('const handle = query(args);', `const captureHooks = args.options.hooks?.PreToolUse?.map((group) => ({ ...group, hooks: group.hooks.map((hook) => async (...params: Parameters<typeof hook>) => {
            const event = params[0];
            if (event.hook_event_name === 'PreToolUse') console.log(JSON.stringify({ fixtureHook: { sessionId: event.session_id, promptId: event.prompt_id, toolUseId: event.tool_use_id }, callbackToolUseId: params[1] }));
            return hook(...params);
          }) }));
          async function* capturedInputs() { for await (const value of args.prompt) { console.log(JSON.stringify({ fixtureInputUuid: value.uuid })); yield value; } }
          const handle = query({ ...args, prompt: capturedInputs(), options: { ...args.options, hooks: { ...args.options.hooks, PreToolUse: captureHooks }, debugFile: join(root, 'sdk.debug.log') } });`)
        .replace('failure = new Error(', "const debug = await readFile(join(root, 'sdk.debug.log'), 'utf8').catch(() => 'no SDK debug file');\n    console.error(debug.slice(-16000));\n    failure = new Error(");
      adapted = adapted.replace('const readiness: unknown[] = [];', "const readiness: unknown[] = [];\n  const toolBindings: { operationRef: string; inputId: string; nativeToolUseId: string; sessionRef: string }[] = [];");
      const custody = 'custody: owner.port, sessionExists:';
      assert.ok(adapted.includes(custody));
      adapted = adapted.replace(custody, `toolBinding: { matchedToolNames: ['mcp__fixture__ping'], prepare: async (request) => {
          toolBindings.push(request);
          assert.equal(request.sessionRef, \`session-\${tag}\`);
          assert.equal(request.inputId, \`input-\${request.operationRef}\`);
          assert.match(request.nativeToolUseId, /^tool_fixture_/);
          assert.equal(request.toolName, 'mcp__fixture__ping');
          return { updatedInput: { marker: 'BOUND_' + (request.toolInput as { marker: string }).marker } };
        } },
        custody: owner.port, sessionExists:`);
      adapted = adapted.replace("const beforeCancelCalls = await readFile(join(root, 'b.calls'), 'utf8');", `const beforeCancelCalls = await readFile(join(root, 'b.calls'), 'utf8');
    assert.equal(JSON.parse((await readFile(join(root, 'a.calls'), 'utf8')).trim()).marker, 'BOUND_A_ONE');
    assert.equal(JSON.parse(beforeCancelCalls.trim()).marker, 'BOUND_B_PERMISSION');
    assert.deepEqual(toolBindings.map((item) => item.operationRef), ['a-1', 'b-permission']);`);
    }
    // C's provider-neutral reply may be asynchronous; preserve every original assertion.
    adapted = awaitInteractionReplies(adapted.replaceAll("'sdk-consumed'", "'client-consumed'"), path);
    await mkdir(dirname(join(sandbox, path)), { recursive: true });
    await writeFile(join(sandbox, path), adapted);
  }
  runConsumer(['exec', 'tsc', '--noEmit', '--allowImportingTsExtensions', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2024', ...files], sandbox);
  execFileSync(process.execPath, ['--test', '--test-timeout=130000', 'test/session.test.ts', 'test/failures.test.ts', 'test/sdk-process.e2e.test.ts'], { cwd: sandbox, stdio: 'inherit', timeout: 140000 });
  const archive = await retainCheckedArchive(installed.archive, process.argv[3]);
  console.log(JSON.stringify({ passed: true, fixtureSource: revision, algorithm: 'installed-provider-tarball-only', runtimeContract: 'actual-workspace-C-archives', authentication: 'synthetic-localhost-only',
    ...archive }));
} finally { await rm(sandbox, { recursive: true, force: true }); }
