import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openClaudeSession, captureClaudeExtraArgs } from '../../../../src/claude.ts'
import { captureCodexExtraArgs } from '../../../../src/codex.ts'
import { captureOpenCodeExtraArgs } from '../../../../src/opencode.ts'
import { compatibility, snapshotConfig } from '../../../../src/features/provider-session-implementation/adapters/claude-sdk/config.ts'
import { configuration, QueryFixture } from './support.ts'

test('captured CLI values preserve order repeats empty strings equals form and literal shell text', () => {
  const selected = ['--max-turns', '5', '--debug', '', '--debug=api,mcp', '--max-turns', '7', '--json-schema', '{"value":"$(TEST);literal"}']
  const captured = captureClaudeExtraArgs(selected)
  selected[1] = '100'; selected.push('--session-id', 'foreign')
  assert.deepEqual(captured, ['--max-turns', '5', '--debug', '', '--debug=api,mcp', '--max-turns', '7', '--json-schema', '{"value":"$(TEST);literal"}'])
  assert.equal(Object.isFrozen(captured), true)
  assert.deepEqual(captureCodexExtraArgs(['--strict-config', '--analytics-default-enabled']), ['--strict-config', '--analytics-default-enabled'])
  assert.deepEqual(captureOpenCodeExtraArgs(['--log-level', 'DEBUG', '--print-logs']), ['--log-level', 'DEBUG', '--print-logs'])
})

test('native aliases and equals forms cannot retarget captured identity tools transport root or account configuration', () => {
  for (const flag of ['-rforeign', '-wforeign', '--session-id=foreign', '--resume=foreign', '--mcp-config=foreign', '--allowed-tools=Agent', '--allow-dangerously-skip-permissions', '--add-dir=/foreign', '--bare', '--debug-file=/foreign']) {
    assert.throws(() => captureClaudeExtraArgs([flag]), /provider.cli.(?:managed-argument|invalid-args)/u)
  }
  for (const flag of ['-C/foreign', '-cmodel=foreign', '--listen=ws://foreign', '--profile=foreign', '--ws-token-file=/foreign', '--enable=foreign']) {
    assert.throws(() => captureCodexExtraArgs([flag]), /provider.cli.(?:managed-argument|invalid-args)/u)
  }
  for (const flag of ['-sforeign', '--hostname=foreign', '--port=1', '--cors=foreign', '--auto', '--pure', '--model=foreign']) {
    assert.throws(() => captureOpenCodeExtraArgs([flag]), /provider.cli.(?:managed-argument|invalid-args)/u)
  }
  for (const args of [['serve'], ['--'], ['--debug', 'bad\nvalue'], Array.from({length:1025}, () => '--debug')]) {
    assert.throws(() => captureClaudeExtraArgs(args), /provider.cli.invalid-args/u)
  }
})

test('Claude refuses managed extras before SDK allocation and appends only original captured argv at its existing spawn port', async () => {
  const rejected = new QueryFixture(), bad = configuration(); bad.extraArgs = ['--session-id=foreign']
  assert.deepEqual(await openClaudeSession(bad, undefined, rejected.boundary), { ok: false, code: 'invalid-config' })
  assert.equal(rejected.calls, 0)
  const sdk = new QueryFixture(), config = configuration(), argv = ['--max-turns', '5', '--debug', '']
  config.extraArgs = argv
  let readCount = 0
  Object.defineProperty(config, 'extraArgs', { enumerable: true, get() {readCount++; return argv} })
  const marker = new Error('TEST captured spawn port')
  let seen: Parameters<typeof config.custody.launch>[0] | undefined
  config.custody.launch = request => {seen = request; throw marker}
  const opened = await openClaudeSession(config, undefined, sdk.boundary); assert.ok(opened.ok)
  argv[1] = '999'; argv.push('--session-id=foreign')
  const signal = new AbortController().signal
  const generated = { command: 'TEST-native', args: ['--session-id', 'SDK-owned', '--input-format', 'stream-json'], cwd: config.cwd, env: { FOREIGN: 'discard' }, signal }
  const spawn = sdk.options.spawnClaudeCodeProcess; assert.ok(spawn)
  assert.throws(() => spawn(generated), error => error === marker)
  assert.ok(seen)
  assert.equal(seen.command, generated.command); assert.equal(seen.cwd, generated.cwd); assert.equal(seen.signal, signal)
  assert.deepEqual(seen.args, [...generated.args, '--max-turns', '5', '--debug', ''])
  assert.deepEqual(seen.env, config.environment)
  assert.equal(readCount, 1)
  await opened.value.close()
})

test('only nonempty ordered native argv changes checkpoint compatibility', () => {
  const base = configuration()
  assert.equal(compatibility(snapshotConfig({ ...base, extraArgs: [] })), compatibility(base))
  const a = compatibility(snapshotConfig({ ...base, extraArgs: ['--max-turns', '5', '--debug'] }))
  assert.notEqual(a, compatibility(base))
  assert.notEqual(a, compatibility(snapshotConfig({ ...base, extraArgs: ['--debug', '--max-turns', '5'] })))
})

test('captured executable is validated before SDK allocation and stays bound across caller mutation and checkpoint reuse', async () => {
  const bad = new QueryFixture()
  assert.deepEqual(await openClaudeSession({ ...configuration(), executablePath: 'relative-claude' }, undefined, bad.boundary), { ok: false, code: 'invalid-config' })
  assert.equal(bad.calls, 0)
  const selected = join(tmpdir(), 'TEST-selected-claude'), sdk = new QueryFixture()
  const config = { ...configuration(), executablePath: selected }
  const captured = snapshotConfig(config), opened = await openClaudeSession(config, undefined, sdk.boundary)
  assert.ok(opened.ok)
  config.executablePath = join(tmpdir(), 'TEST-other-claude')
  assert.equal(sdk.options.pathToClaudeCodeExecutable, selected)
  assert.equal(captured.executablePath, selected)
  assert.notEqual(compatibility(captured), compatibility(config))
  assert.notEqual(compatibility(captured), compatibility(configuration()))
  await opened.value.close()
})

test('real SDK chooses the captured executable instead of its bundled default before the owner permits any spawn', () => {
  const root = mkdtempSync(join(tmpdir(), 'TEST-claude-selected-'))
  try {
    for (const name of ['home', 'config', 'workspace', 'tmp']) { mkdirSync(join(root, name)) }
    const executablePath = join(root, process.platform === 'win32' ? 'claude.exe' : 'claude')
    writeFileSync(executablePath, 'TEST: custody always refuses; this file is never executed\n')
    const environment = { HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'config'), TMPDIR: join(root, 'tmp'), PATH: dirname(process.execPath), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' }
    const config = { ...configuration(), cwd: join(root, 'workspace'), executablePath, environment }
    const source = `import assert from 'node:assert/strict';
      import { openClaudeSession } from ${JSON.stringify(new URL('../../../../src/claude.ts', import.meta.url).href)};
      const config=${JSON.stringify(config)}, seen=[];
      config.probe=async()=>true; config.sessionExists=async()=>false;
      config.custody={launch:request=>{seen.push({command:request.command,cwd:request.cwd});throw new Error('TEST refuses before native spawn');},confirmStopped:async()=>true};
      const opened=await openClaudeSession(config);
      assert.deepEqual(opened,{ok:false,code:'provider-failure'});
      assert.deepEqual(seen,[{command:config.executablePath,cwd:config.cwd}]);
      console.log(JSON.stringify({nativeAllocations:0,seen}));`
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: root, env: { ...environment, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.deepEqual(JSON.parse(output), { nativeAllocations: 0, seen: [{ command: executablePath, cwd: config.cwd }] })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('finite native value arity refuses unbound bootstrap prompts and subcommands while retaining supported variadics and short debug values', () => {
  for (const args of [['--max-turns', '5', 'unowned prompt'], ['--debug', 'api', 'unowned prompt'], ['--disable-slash-commands', 'unowned prompt'], ['--max-turns'], ['--debug', '--', 'prompt']]) {
    assert.throws(() => captureClaudeExtraArgs(args), /provider.cli.invalid-args/u)
  }
  assert.throws(() => captureCodexExtraArgs(['--strict-config', 'proxy']), /provider.cli.invalid-args/u)
  assert.throws(() => captureOpenCodeExtraArgs(['--log-level', 'DEBUG', 'serve']), /provider.cli.invalid-args/u)
  assert.throws(() => captureClaudeExtraArgs(['--unqualified-native-flag']), /provider.cli.unsupported-argument/u)
  const safe = ['--betas', 'TEST-one', 'TEST-two', '--betas=TEST-three', '--debug', '', '-dapi,mcp', '--json-schema', '']
  assert.deepEqual(captureClaudeExtraArgs(safe), safe)
  assert.deepEqual(captureOpenCodeExtraArgs(['--print-logs=false']), ['--print-logs=false'])
})
