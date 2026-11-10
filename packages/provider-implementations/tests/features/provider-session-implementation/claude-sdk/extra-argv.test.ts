import assert from 'node:assert/strict'
import { test } from 'node:test'
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
