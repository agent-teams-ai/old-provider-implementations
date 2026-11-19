import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

// One native App Server + one scripted localhost Responses endpoint.
// This is not a vendor-authenticated model run or a product Host/Electron E2E.
const expectedVersion = '0.166.0';
const prefix = process.env.NATIVE_SUGGESTIONS_CODEX_PREFIX;
const receiptPath = process.env.NATIVE_SUGGESTIONS_RECEIPT;
assert.ok(prefix && receiptPath, 'the runner must select the exact test binary and receipt');
const binary = join(prefix, 'node_modules', '.bin', 'codex');
const manifest = JSON.parse(await readFile(join(prefix, 'node_modules', '@openai', 'codex', 'package.json'), 'utf8'));
assert.equal(manifest.version, expectedVersion, 'do not silently upgrade the native protocol');
const root = await mkdtemp(join(tmpdir(), 'TEST-native-prompt-suggestion-'));
const cwd = join(root, 'workspace'), home = join(root, 'home'), codexHome = join(root, 'codex');
await Promise.all([cwd, home, codexHome].map(p => mkdir(p, { recursive: true, mode: 0o700 })));

let native;
let server;
let nativeExit;
const stderr = [];
const requests = [];
const errors = [];
const seenToolEffects = [];
const markerA = 'TEST_NATIVE_PROMPT_ONE_6b0f';
const markerB = 'TEST_NATIVE_PROMPT_TWO_c43a';
const suggestion = 'Review the tests and open a PR';
const pending = new Map();
const notifications = [];
const awaiters = new Set();
let rpcSerial = 0;
let nativeVersion = '';

function modelText(messages) {
  return JSON.stringify(messages);
}
function sendSse(response, text, sequence) {
  const id = 'TEST-local-response-' + sequence;
  const events = [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: id + '-message',
      content: [{ type: 'output_text', text }] } },
    { type: 'response.completed', response: { id, usage: { input_tokens: 45,
      input_tokens_details: null, output_tokens: 11, output_tokens_details: null, total_tokens: 56 } } },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  response.end(events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''));
}
function finishEvent(frame) {
  return frame.method === 'turn/completed'
    && typeof frame.params?.turn?.id === 'string'
    && frame.params?.turn?.status === 'completed';
}
function processLine(line) {
  let frame;
  try { frame = JSON.parse(line); } catch { errors.push('malformed native JSON-RPC'); return; }
  if (typeof frame.method === 'string' && /(?:commandExecution|fileChange|applyPatch|execCommand)/i.test(frame.method)) {
    seenToolEffects.push(frame.method);
  }
  if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
    const waiter = pending.get(frame.id);
    if (!waiter) { errors.push('unattributed response ID'); return; }
    pending.delete(frame.id);
    if (frame.error) waiter.reject(new Error('native RPC ' + String(frame.error.code) + ': ' + String(frame.error.message).slice(0,200)));
    else waiter.resolve(frame.result);
    return;
  }
  if (frame.id !== undefined && typeof frame.method === 'string') {
    // Never grant a native permission; the fixture has no operational tools.
    native.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id,
      error: { code: -32001, message: 'TEST server request denied' } }) + '\n');
    return;
  }
  if (typeof frame.method === 'string') {
    notifications.push(frame);
    for (const listener of awaiters) listener();
  }
}
function write(frame) {
  assert.ok(native && native.exitCode === null, 'original native process must still be alive');
  native.stdin.write(JSON.stringify(frame) + '\n');
}
async function request(method, params, ms = 25000) {
  const id = 'TEST-client-' + ++rpcSerial;
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('native RPC timeout: ' + method));
    }, ms);
    pending.set(id, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: reason => { clearTimeout(timeout); reject(reason); },
    });
  });
  write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  return result;
}
function notify(method) { write({ jsonrpc: '2.0', method }); }
async function event(predicate, ms = 45000) {
  const started = Date.now();
  for (;;) {
    const hit = notifications.find(predicate);
    if (hit) { notifications.splice(notifications.indexOf(hit), 1); return hit; }
    if (Date.now() - started > ms) throw new Error('native notification timeout');
    await new Promise((resolve, reject) => {
      const wait = () => { clearTimeout(timeout); awaiters.delete(wait); resolve(); };
      const timeout = setTimeout(() => { awaiters.delete(wait); reject(new Error('native notification timeout')); }, Math.max(1, ms - (Date.now() - started)));
      awaiters.add(wait);
    });
  }
}
async function turn(threadId, marker) {
  const resp = await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Respond with one short sentence to ' + marker, text_elements: [] }],
  });
  const turnId = resp?.turn?.id;
  assert.equal(typeof turnId, 'string');
  const terminal = await event(x => finishEvent(x) && x.params?.threadId === threadId && x.params?.turn?.id === turnId);
  assert.equal(terminal.params.turn.status, 'completed');
  return turnId;
}

let resultSummary;
try {
  const observed = [];
  server = createServer((req, res) => {
    void (async () => {
      assert.equal(req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::ffff:127.0.0.1', true);
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/responses');
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_000_000) throw new Error('native model request exceeded test budget');
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const raw = modelText(body.input);
      const isSample = raw.includes('Predict the next message') || raw.includes('next message the user will send');
      const priorA = raw.includes(markerA), priorB = raw.includes(markerB);
      requests.push({ model: typeof body.model, isSample, priorA, priorB,
        tools: Array.isArray(body.tools) ? body.tools.length : 0 });
      if (requests.length > 8) throw new Error('unexpected model request amplification');
      if (isSample) {
        if (!priorA || !priorB) throw new Error('sample did not inherit both original user inputs');
        sendSse(res, suggestion, requests.length);
        return;
      }
      observed.push({ priorA, priorB });
      if (!priorA && !priorB) throw new Error('native normal turn omitted original input');
      sendSse(res, priorB ? 'Second TEST reply' : 'First TEST reply', requests.length);
    })().catch(e => {
      errors.push(e instanceof Error ? e.message : 'model fixture failed');
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('TEST fake model refused the request');
    });
  });
  server.requestTimeout = 20000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = 'http://127.0.0.1:' + address.port;
  const config = [
    'model = "gpt-5.2-codex"',
    'model_provider = "TEST_fixture"',
    'model_reasoning_effort = "low"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    '[model_providers.TEST_fixture]',
    'name = "TEST fixture"',
    'base_url = "' + url + '/v1"',
    'env_key = "TEST_CODEX_FIXTURE_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
  ].join('\n');
  await writeFile(join(codexHome, 'config.toml'), config, { mode: 0o600, flag: 'wx' });
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome,
    TMPDIR: root, TEST_CODEX_FIXTURE_KEY: 'TEST-LOCALHOST-ONLY', NO_COLOR: '1',
    RUST_LOG: 'warn', LANG: 'C.UTF-8' };
  native = spawn(binary, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  nativeExit = once(native, 'close').then(([code, signal]) => ({ code, signal }));
  native.stderr.on('data', chunk => { if (stderr.length < 30) stderr.push(String(chunk).slice(0, 500)); });
  const reader = readline.createInterface({ input: native.stdout });
  reader.on('line', processLine);
  const init = await request('initialize', { clientInfo: { name: 'agent-teams-test', version: '0.0.0' },
    capabilities: { experimentalApi: true } });
  assert.ok(init && typeof init === 'object');
  notify('initialized');
  const started = await request('thread/start', { cwd, model: 'gpt-5.2-codex',
    approvalPolicy: 'never', sandbox: 'read-only' });
  const threadId = started?.thread?.id;
  assert.equal(typeof threadId, 'string');
  const first = await turn(threadId, markerA);
  const second = await turn(threadId, markerB);
  assert.notEqual(first, second);
  const before = await request('thread/read', { threadId, includeTurns: true });
  const sample = await request('thread/sample', { threadId, expectedTurnId: second,
    prompt: 'Predict the next message the user will send. Reply with only the message. Do not use tools.',
    effort: 'low' });
  const after = await request('thread/read', { threadId, includeTurns: true });
  assert.equal(sample?.sourceTurnId, second, 'sample must bind the exact completed native turn');
  assert.equal(sample?.text, suggestion, 'no tool, no model-fabricated history');
  assert.ok(typeof sample.responseId === 'string' && sample.responseId.length > 0);
  assert.deepEqual(before?.thread?.turns, after?.thread?.turns,
    'ephemeral native sampling cannot modify original source conversation turns');
  assert.equal(requests.filter(r => r.isSample).length, 1, 'only one extra inference');
  assert.equal(requests.filter(r => !r.isSample).length, 2, 'exactly two normal turns');
  assert.equal(requests[2]?.priorA && requests[2]?.priorB, true, 'actual model received both prior human inputs');
  assert.equal(seenToolEffects.length, 0, 'no tool or approval effects from native sampling');
  assert.deepEqual(errors, []);
  resultSummary = { passed: true, nativeCliVersion: expectedVersion, sourceTurns: 2,
    nativeSampleRequests: 1, inheritedContext: true, sourceUnchanged: true,
    toolEffects: 0, vendorAuth: false, model: 'localhost-scripted-responses',
    environment: process.platform + '-' + process.arch };
} catch (err) {
  resultSummary = { passed: false, nativeCliVersion: expectedVersion,
    reason: err instanceof Error ? String(err.message).slice(0, 260) : 'unknown',
    modelRequests: requests.length, nativeSampleRequests: requests.filter(r => r.isSample).length,
    fixtureErrors: errors.map(s => s.slice(0, 200)), stderrLineCount: stderr.length,
    vendorAuth: false, environment: process.platform + '-' + process.arch };
} finally {
  for (const [id, waiter] of pending) waiter.reject(new Error('TEST cleanup'));
  pending.clear();
  try { native?.stdin.end(); } catch {}
  if (native && native.exitCode === null && native.signalCode === null) {
    native.kill('SIGTERM');
    const exited = await Promise.race([nativeExit, new Promise(resolve => setTimeout(() => resolve(null), 1500))]);
    if (!exited) { native.kill('SIGKILL'); await nativeExit; }
  }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(root, { force: true, recursive: true });
}
await writeFile(receiptPath, JSON.stringify(resultSummary, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(resultSummary));
if (!resultSummary.passed) process.exitCode = 1;
