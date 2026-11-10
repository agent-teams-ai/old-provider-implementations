import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeCodexApprovalResponse, mapCodexNativeExecLine as line, mapCodexNativeExecOutput as output, normalizeCodexAppServerApprovalRequest as approval } from '../../../../src/codex.ts'

test('thread, assistant and terminal usage retain order without task lifecycle effects', () => {
  assert.deepEqual(output([
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-A' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', id: 'a', text: 'OK' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } }),
  ].join('\r\n')), [
    { type: 'thread_started', threadId: 'thread-A' }, { type: 'turn_started' },
    { type: 'assistant_text', itemId: 'a', text: 'OK' },
    { type: 'usage_updated', inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 }, { type: 'turn_completed' },
  ])
})

test('MCP arguments, results and provider errors retain their own correlation', () => {
  const item = { id: 'mcp-1', type: 'mcp_tool_call', server: 'control', tool: 'message_send', arguments: { to: 'B' }, status: 'completed', result: { content: [{ type: 'text', text: 'committed' }] } }
  const events = line(JSON.stringify({ type: 'item.completed', item }))
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], { type: 'tool_call_completed', itemId: 'mcp-1', toolSource: 'mcp', serverName: 'control', toolName: 'message_send', arguments: { to: 'B' }, status: 'completed', resultText: 'committed', rawResult: item.result, errorMessage: null, isError: false, rawItemType: 'mcp_tool_call' })
  const failed = line(JSON.stringify({ type: 'item.completed', item: { ...item, status: 'failed', result: null, error: { message: 'denied' } } }))[0]
  assert.equal(failed?.type, 'tool_call_completed')
  if (failed?.type === 'tool_call_completed') {assert.equal(failed.isError, true)}
})

test('native mapping is per invocation; disabled native tools do not suppress MCP', () => {
  const raw = JSON.stringify({ type: 'item.completed', item: { id: 'cmd', type: 'command_execution', command: 'pwd', aggregated_output: '/sandbox', exit_code: 2, status: 'completed' } })
  assert.deepEqual(line(raw, { nativeTools: false }), [])
  const mapped = line(raw, { nativeTools: true })[0]
  assert.equal(mapped?.type, 'tool_call_completed')
  if (mapped?.type === 'tool_call_completed') {
    assert.equal(mapped.isError, true)
    assert.equal(mapped.itemId, 'cmd')
    assert.equal(mapped.toolSource, 'native')
  }
  assert.equal(line(raw)[0]?.type, 'tool_call_completed')
  const mcp = JSON.stringify({ type: 'item.started', item: { id: 'm', type: 'mcp_tool_call', server: 'control', tool: 'task_get', arguments: {}, status: 'in_progress' } })
  assert.equal(line(mcp, { nativeTools: false })[0]?.type, 'tool_call_started')
})

test('malformed output and unsupported events stay observable; ordinary text is not success', () => {
  assert.deepEqual(line(''), [])
  for (const raw of ['provider warning', '{invalid', 'null']) {
    const events = line(raw)
    assert.equal(events[0]?.type, 'warning')
    assert.ok(!events.some(observation => observation.type === 'turn_completed'))
  }
  assert.deepEqual(line('{"type":"future.event","opaque":1}'), [{ type: 'unsupported_raw_event', rawType: 'future.event', payload: { type: 'future.event', opaque: 1 } }])
  assert.deepEqual(line('{"method":"thread.started","params":{"thread_id":"rpc-thread"}}'), [{ type: 'thread_started', threadId: 'rpc-thread' }])
})

test('modern and legacy approval identities preserve turn/item/provider distinctions', () => {
  const command = approval({ id: 12, method: 'item/commandExecution/requestApproval', params: { threadId: 't', turnId: 'u', itemId: 'i', command: 'pnpm test', cwd: '/sandbox' } })
  assert.equal(command?.providerRequestId, 'codex:item/commandExecution/requestApproval:i')
  assert.equal(command?.requestId, '12')
  assert.equal(command?.turnId, 'u')
  assert.equal(command?.toolInput.command, 'pnpm test')
  const legacy = approval({ id: 'rpc', method: 'applyPatchApproval', params: { conversationId: 't-old', callId: 'call', fileChanges: { '/sandbox/a': { add: true } } } })
  assert.equal(legacy?.threadId, 't-old')
  assert.equal(legacy?.providerRequestId, 'codex:applyPatchApproval:call')
  assert.deepEqual(legacy?.toolInput.filePaths, ['/sandbox/a'])
  assert.equal(approval({ id: 'rpc', method: 'futureApproval' }), null)
})

test('response encoder uses only the explicit decision, never implicit session escalation', () => {
  const request = { id: 1, method: 'item/commandExecution/requestApproval', params: { availableDecisions: ['acceptForSession', 'decline'] } }
  assert.throws(() => encodeCodexApprovalResponse(request, { kind: 'decision', decision: 'accept' }), /unsupported-decision/)
  assert.deepEqual(encodeCodexApprovalResponse(request, { kind: 'decision', decision: 'decline' }), { jsonrpc: '2.0', id: 1, result: { decision: 'decline' } })
  assert.deepEqual(encodeCodexApprovalResponse(request, { kind: 'decision', decision: 'acceptForSession' }).result, { decision: 'acceptForSession' })
  assert.throws(() => encodeCodexApprovalResponse(request, { kind: 'decision', decision: 'approved' }))
  assert.throws(() => encodeCodexApprovalResponse({ ...request, method: 'unknown' }, { kind: 'decision', decision: 'decline' }))
  assert.deepEqual(encodeCodexApprovalResponse({ id: 'old', method: 'execCommandApproval' }, { kind: 'decision', decision: 'denied' }).result, { decision: 'denied' })
})

test('permission reply contains only the explicit runtime grant, not all requested access', () => {
  const request = { id: 'p', method: 'item/permissions/requestApproval', params: { permissions: { network: { allowed: ['remote.example'] }, fileSystem: { writableRoots: ['/sandbox'] } } } }
  assert.deepEqual(encodeCodexApprovalResponse(request, { kind: 'permissions', permissions: {}, scope: 'turn' }).result, { permissions: {}, scope: 'turn' })
  assert.deepEqual(encodeCodexApprovalResponse(request, { kind: 'permissions', permissions: { network: { allowed: [] } }, scope: 'turn' }).result, { permissions: { network: { allowed: [] } }, scope: 'turn' })
  assert.throws(() => encodeCodexApprovalResponse(request, { kind: 'decision', decision: 'accept' }))
  assert.throws(() => encodeCodexApprovalResponse(request, { kind: 'permissions', permissions: { everything: true }, scope: 'turn' }))
})


test('malformed nested provider data cannot manufacture completion or crash later JSONL records', () => {
  const malformed = [
    { type: 'item.completed', item: { id: 'f', type: 'file_change', changes: [null] } },
    { type: 'item.started', item: { id: 'f', type: 'file_change', changes: 'invalid' } },
    { type: 'item.completed', item: [] },
    { type: 'turn.completed', usage: { output_tokens: '3' } },
    { type: 'turn.failed', error: [] },
  ]
  for (const event of malformed) {
    const events = output(`${JSON.stringify(event)}\n{"type":"thread.started","thread_id":"next"}`)
    assert.equal(events[0]?.type, 'warning')
    assert.equal(events[1]?.type, 'thread_started')
    assert.ok(!events.some(observation => observation.type === 'turn_completed'))
  }
  assert.deepEqual(line('{"method":"thread.started","params":{"thread_id":"rpc","type":"turn.completed"}}'), [{ type: 'thread_started', threadId: 'rpc' }])
})

test('native file changes and terminal failures remain provider observations', () => {
  const change = { id: 'edit', type: 'file_change', changes: [{ path: '/sandbox/old.ts', kind: 'delete' }], status: 'failed' }
  const event = line(JSON.stringify({ type: 'item.completed', item: change }))[0]
  assert.equal(event?.type, 'tool_call_completed')
  if (event?.type === 'tool_call_completed') {
    assert.equal(event.toolName, 'Edit')
    assert.equal(event.arguments.file_path, '/sandbox/old.ts')
    assert.equal(event.isError, true)
    assert.match(event.resultText ?? '', /delete/u)
  }
  const failed = line('{"type":"turn.failed","error":{"message":"provider unavailable"}}')
  assert.deepEqual(failed, [
    { type: 'warning', source: 'codex', text: 'Codex native turn failed: provider unavailable' },
    { type: 'turn_failed', errorMessage: 'provider unavailable' },
  ])
  assert.ok(!failed.some(observation => observation.type === 'turn_completed'))
})


test('native turn failure is terminal without an optional diagnostic message', () => {
  for (const event of [
    { type: 'turn.failed' },
    { type: 'turn.failed', error: {} },
    { type: 'turn.failed', error: { message: '  ' } },
  ]) {assert.deepEqual(line(JSON.stringify(event)), [{ type: 'turn_failed' }])}
  // An ordinary provider error is a diagnostic, not a native turn outcome.
  assert.deepEqual(line('{"type":"error","message":"retrying transport"}'), [
    { type: 'warning', source: 'codex', text: 'Codex native error: retrying transport' },
  ])
})

test('usage distinguishes missing counters from observed zero and rejects invalid token counts', () => {
  for (const event of [{ type: 'turn.completed' }, { type: 'turn.completed', usage: {} }]) {
    assert.deepEqual(line(JSON.stringify(event)), [{ type: 'turn_completed' }])
  }
  assert.deepEqual(line('{"type":"turn.completed","usage":{"input_tokens":0}}'), [
    { type: 'usage_updated', inputTokens: 0 }, { type: 'turn_completed' },
  ])
  assert.deepEqual(line('{"type":"turn.completed","usage":{"cached_input_tokens":0,"output_tokens":5}}'), [
    { type: 'usage_updated', cachedInputTokens: 0, outputTokens: 5 }, { type: 'turn_completed' },
  ])
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
    for (const count of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const raw = JSON.stringify({ type: 'turn.completed', usage: { [key]: count } })
      assert.deepEqual(line(raw), [{ type: 'warning', source: 'stderr', text: raw }])
    }
  }
})
