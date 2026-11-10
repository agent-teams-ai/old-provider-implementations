import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

test('real packed contracts install and strict consumer build require no engine, SDK, custody or database', async t => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-provider-session-contracts-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  execFileSync('pnpm', ['pack', '--pack-destination', root], {cwd: packageRoot, stdio: 'pipe'});
  const name = (await readdir(root)).find(value => value.endsWith('.tgz')); assert.ok(name);
  const archive = join(root, name);
  await writeFile(join(root, 'package.json'), JSON.stringify({private: true, type: 'module', dependencies: {'@agent-teams/provider-session-contracts': `file:${archive}`}}));
  execFileSync('pnpm', ['install', '--ignore-scripts'], {cwd: root, stdio: 'pipe', timeout: 20000});
  const installed = JSON.parse(await readFile(join(root, 'node_modules/@agent-teams/provider-session-contracts/package.json'), 'utf8'));
  assert.equal(installed.dependencies, undefined);
  assert.equal(installed.peerDependencies, undefined);
  const lock = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8');
  for (const forbidden of ['agent-execution', 'filesystem-custody', 'pg@', 'anthropic', 'claude-runtime', 'link:']) {assert.ok(!lock.includes(forbidden), forbidden);}
  await writeFile(join(root, 'consumer.ts'), `import type {DriverFactory, Session, Input, Reply, Handoff, OpenConfig, FailureCode, EventPayload} from '@agent-teams/provider-session-contracts';
export async function consume(factory: DriverFactory, config: OpenConfig, input: Input): Promise<Reply<Handoff>> {
 const session: Session = (await factory.open(config)).driver;
 const result = await session.submit(input);
 if (!result.ok) {const code: FailureCode = result.code; if(code === 'unknown') await session.interrupt(input.operationRef);}
 for await (const event of session.observe()) {const payload: EventPayload = event; if(payload.kind === 'result') break;}
 await session.close(); return result;
}
`);
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({compilerOptions: {strict: true, skipLibCheck: false, types: [], lib: ['ES2024'], module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2024', outDir: 'out'}, files: ['consumer.ts']}));
  const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
  execFileSync(process.execPath, [compiler, '--project', 'tsconfig.json', '--pretty', 'false'], {cwd: root, stdio: 'pipe'});
  execFileSync(process.execPath, ['out/consumer.js'], {cwd: root, stdio: 'pipe'});
  const values = execFileSync(process.execPath, ['--input-type=module', '-e', 'console.log(JSON.stringify(Object.keys(await import("@agent-teams/provider-session-contracts"))))'], {cwd: root, encoding: 'utf8'});
  assert.deepEqual(JSON.parse(values), []);
  await writeFile(join(root, 'consumer.ts'), 'import type {ClaudeConfig} from "@agent-teams/provider-session-contracts";');
  assert.throws(() => execFileSync(process.execPath, [compiler, '--project', 'tsconfig.json'], {cwd: root, stdio: 'pipe'}), error => {
    assert.match(String((error as {stdout?: Buffer}).stdout), /TS2305.*ClaudeConfig/u); return true;
  });
});
