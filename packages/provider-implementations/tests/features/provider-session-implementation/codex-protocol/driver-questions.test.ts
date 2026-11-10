import assert from 'node:assert/strict'
import { test } from 'node:test'
import { opened, input, ref, until } from './driver-support.ts'

for (const method of ['item/tool/requestUserInput', 'mcpServer/elicitation/request']) {
  test(`exact native ${method} projects existing question UI and one-request wire reply`, async t => {
    const c = await opened(t); await c.driver.submit(input()); const turn = ref(c.native)
    const params = method === 'item/tool/requestUserInput'
      ? { ...turn, itemId: 'question-item', questions: [{ id: 'mcp_tool_call_approval_echo', header: 'Approve tool', question: 'Allow TEST echo?', isOther: false, isSecret: false,
        options: [{ label: 'Allow', description: 'Once' }, { label: 'Allow for this session', description: 'Broad' }, { label: "Allow and don't ask me again", description: 'Persist' }, { label: 'Cancel', description: 'Stop' }] }], isBlocking: true, autoResolutionMs: null }
      : { ...turn, serverName: 'TEST-server', mode: 'form', message: 'Allow TEST echo?', requestedSchema: { type: 'object', properties: {} }, _meta: null }
    await c.native.command({ kind: 'approval', requestId: 'native-question-A', method, params })
    await until(() => c.events.some(event => event.kind === 'interaction'))
    const event = c.events.find(row => row.kind === 'interaction'); assert(event?.kind === 'interaction' && event.request.kind === 'question')
    assert.equal(event.sessionRef, 'runtime-A'); assert.equal(event.inputId, 'input-1'); assert.equal(event.operationRef, 'op-1')
    const questions = event.request.questions as { question: string; options: {label: string}[] }[]
    assert.equal(questions.length, 1); assert(!JSON.stringify(questions).includes('Allow for this session'))
    assert.deepEqual(await c.driver.respondToInteraction(event.interactionRef, {kind:'permission',decision:'allow'}), {ok:false,code:'unsupported'})
    assert.deepEqual(await c.driver.respondToInteraction(event.interactionRef, {kind:'question',answers:{[questions[0]!.question]:'Allow for this session'}}), {ok:false,code:'unsupported'})
    assert((await c.driver.respondToInteraction(event.interactionRef, { kind: 'question', answers: { [questions[0]!.question]: questions[0]!.options[0]!.label } })).ok)
    await c.native.waitFor(value => value.event === 'wire' && (value.message as Record<string, unknown>)?.id === 'native-question-A')
    assert.deepEqual(c.native.writes.find(frame => frame.id === 'native-question-A')?.result,
      method === 'item/tool/requestUserInput' ? { answers: { mcp_tool_call_approval_echo: { answers: ['Allow'] } } } : { action: 'accept', content: {}, _meta: null })
    assert.deepEqual(await c.driver.respondToInteraction(event.interactionRef, {kind:'question',decision:'deny'}),{ok:false,code:'stale'})
  })
}

const form = (turn: {threadId: string; turnId: string}) => ({ ...turn, serverName: 'TEST-server', mode: 'form', message: 'Choose TEST values', _meta: null,
  requestedSchema: { type: 'object', properties: { color: { type: 'string', enum: ['blue', 'red'] }, ready: { type: 'boolean' } }, required: ['color', 'ready'] } })

test('finite form answers retain field types and exact original JSON-RPC id without metadata grants', async t => {
  const c = await opened(t); await c.driver.submit(input()); const turn = ref(c.native)
  await c.native.command({ kind: 'approval', requestId: 41, method: 'mcpServer/elicitation/request', params: form(turn) })
  await until(() => c.events.some(event => event.kind === 'interaction'))
  const e = c.events.find(event => event.kind === 'interaction'); assert(e?.kind === 'interaction' && e.request.kind === 'question')
  const q = e.request.questions as { question: string }[]
  assert.deepEqual(await c.driver.respondToInteraction(e.interactionRef, { kind: 'question', answers: { [q[0]!.question]: 'blue' } }), { ok: false, code: 'unsupported' })
  assert((await c.driver.respondToInteraction(e.interactionRef, { kind: 'question', answers: { [q[0]!.question]: 'blue', [q[1]!.question]: 'No' } })).ok)
  await c.native.waitFor(value => value.event === 'wire' && (value.message as Record<string, unknown>)?.id === 41)
  assert.deepEqual(c.native.writes.find(frame => frame.id === 41)?.result, { action: 'accept', content: { color: 'blue', ready: false }, _meta: null })
})

test('unsupported native forms fail closed with explicit diagnostic and never create a question', async t => {
  const c = await opened(t); await c.driver.submit(input()); const turn = ref(c.native)
  const invalid = [
    { ...form(turn), mode: 'url', url: 'https://TEST.invalid', elicitationId: 'TEST-auth' },
    { ...form(turn), mode: 'openai/userVerification', challenge: 'TEST-secret' },
    ...['string', 'number', 'integer', 'array', 'object'].map(type => ({ ...form(turn), requestedSchema: { type: 'object', properties: { secret: { type } } } })),
    { ...form(turn), requestedSchema: { type: 'object', properties: { a: { type: 'string', enum: ['same', 'same'] } } } },
    { ...form(turn), requestedSchema: { type: 'object', properties: { a: { type: 'boolean', unknown: true } } } },
    { ...form(turn), requestedSchema: { type: 'object', properties: {}, required: ['missing'] } },
  ]
  for (const [n, params] of invalid.entries()) {
    const requestId = `unsupported-${n}`
    await c.native.command({ kind: 'approval', requestId, method: 'mcpServer/elicitation/request', params })
    await c.native.waitFor(value => value.event === 'wire' && (value.message as Record<string, unknown>)?.id === requestId)
    assert.deepEqual(c.native.writes.find(frame => frame.id === requestId)?.result, { action: 'decline', content: null, _meta: null })
  }
  assert.equal(c.events.filter(event => event.kind === 'interaction').length, 0)
  assert.equal(c.events.filter(event => event.kind === 'diagnostic' && event.code === 'unsupported' && event.inputId === 'input-1' && event.operationRef === 'op-1').length, invalid.length)
})

test('secret, free text, duplicate ids and automatic/nonblocking user-input requests never become grants', async t => {
  const c = await opened(t); await c.driver.submit(input()); const turn = ref(c.native)
  const q = { id: 'id-A', question: 'Question A', header: 'TEST', options: [{ label: 'A', description: 'Choice A' }] }
  const params = { ...turn, itemId: 'item-A', questions: [q] }
  const invalid = [
    { ...params, questions: [{ ...q, isSecret: true }] }, { ...params, questions: [{ ...q, isOther: true }] },
    { ...params, questions: [{ ...q, options: null }] }, { ...params, questions: [q, q] },
    { ...params, isBlocking: false }, { ...params, autoResolutionMs: 20 },
  ]
  for (const [n, value] of invalid.entries()) {
    const requestId = `unsupported-user-${n}`
    await c.native.command({ kind: 'approval', requestId, method: 'item/tool/requestUserInput', params: value })
    await c.native.waitFor(row => row.event === 'wire' && (row.message as Record<string, unknown>)?.id === requestId)
    assert.deepEqual(c.native.writes.find(frame => frame.id === requestId)?.result, { answers: {} })
  }
  assert.equal(c.events.filter(event => event.kind === 'interaction').length, 0)
})

test('uncorrelated elicitation or foreign thread/turn cannot borrow current input provenance', async t => {
  const c = await opened(t); await c.driver.submit(input()); const turn = ref(c.native)
  for (const [n, params] of [{ ...form(turn), turnId: null }, { ...form(turn), turnId: 'foreign-turn' }, { ...form(turn), threadId: 'foreign-thread' }].entries()) {
    const requestId = `foreign-${n}`
    await c.native.command({ kind: 'approval', requestId, method: 'mcpServer/elicitation/request', params })
    await c.native.waitFor(value => value.event === 'wire' && (value.message as Record<string, unknown>)?.id === requestId)
    assert(c.native.writes.find(frame => frame.id === requestId)?.error)
    assert.equal(c.native.writes.find(frame => frame.id === requestId)?.result, undefined)
  }
  assert.equal(c.events.some(event => event.kind === 'interaction'), false)
})

test('denial settles only exact pending request; revoked and old-turn question refs stay stale', async t => {
  const c = await opened(t); await c.driver.submit(input()); const turn = ref(c.native)
  await c.native.command({kind:'approval',requestId:'deny-A',method:'mcpServer/elicitation/request',params:form(turn)})
  await until(() => c.events.some(event => event.kind === 'interaction'))
  const first = c.events.find(event => event.kind === 'interaction'); assert(first?.kind==='interaction')
  assert((await c.driver.respondToInteraction(first.interactionRef,{kind:'question',decision:'deny'})).ok)
  await c.native.waitFor(value=>value.event==='wire' && (value.message as Record<string,unknown>)?.id==='deny-A')
  assert.deepEqual(c.native.writes.find(frame=>frame.id==='deny-A')?.result,{action:'decline',content:null,_meta:null})
  await c.native.command({kind:'approval',requestId:'revoked-A',method:'mcpServer/elicitation/request',params:form(turn)})
  await until(() => c.events.filter(event=>event.kind==='interaction').length===2)
  const second=c.events.filter(event=>event.kind==='interaction')[1];assert(second?.kind==='interaction')
  assert((await c.driver.interrupt('op-1')).ok)
  assert.deepEqual(await c.driver.respondToInteraction(second.interactionRef,{kind:'question',answers:{'Choose TEST values — color':'blue','Choose TEST values — ready':'Yes'}}),{ok:false,code:'stale'})
  await c.native.command({kind:'finish',...turn});await until(()=>c.events.some(event=>event.kind==='result'))
  await c.driver.submit(input(2))
  assert.deepEqual(await c.driver.respondToInteraction(first.interactionRef,{kind:'question',decision:'deny'}),{ok:false,code:'stale'})
  assert.equal(c.native.writes.find(frame=>frame.id==='revoked-A')?.result,undefined)
})

test('native question cannot be answered by a neighbor or getter payload, and close removes its original ref', async t => {
  const c = await opened(t), neighbor = await opened(t, 'runtime-B'); await c.driver.submit(input()); const turn = ref(c.native)
  await c.native.command({kind:'approval',requestId:'owned-A',method:'mcpServer/elicitation/request',params:form(turn)})
  await until(()=>c.events.some(event=>event.kind==='interaction'))
  const e=c.events.find(event=>event.kind==='interaction');assert(e?.kind==='interaction')
  assert.deepEqual(await neighbor.driver.respondToInteraction(e.interactionRef,{kind:'question',decision:'deny'}),{ok:false,code:'stale'})
  assert.deepEqual(await c.driver.respondToInteraction('unknown-ref',{kind:'question',decision:'deny'}),{ok:false,code:'stale'})
  let read=0;const hostile=Object.defineProperty({kind:'question',answers:{}},'answers',{get(){read++;throw new Error('must not read')}})
  assert.deepEqual(await c.driver.respondToInteraction(e.interactionRef,hostile as never),{ok:false,code:'unsupported'});assert.equal(read,0)
  await c.driver.close();assert.deepEqual(await c.driver.respondToInteraction(e.interactionRef,{kind:'question',decision:'deny'}),{ok:false,code:'stale'})
  assert.equal(c.native.writes.find(frame=>frame.id==='owned-A')?.result,undefined)
  assert((await neighbor.driver.submit(input())).ok)
})

test('same-turn revoke after a local answer but before native response suppresses the answer', async t => {
  const c=await opened(t);await c.driver.submit(input());const turn=ref(c.native)
  await c.native.command({kind:'approval',requestId:'race-A',method:'mcpServer/elicitation/request',params:form(turn)})
  await until(()=>c.events.some(event=>event.kind==='interaction'))
  const e=c.events.find(event=>event.kind==='interaction');assert(e?.kind==='interaction')
  const answer=c.driver.respondToInteraction(e.interactionRef,{kind:'question',answers:{'Choose TEST values — color':'blue','Choose TEST values — ready':'Yes'}})
  const stopping=c.driver.interrupt('op-1');assert((await answer).ok);assert((await stopping).ok)
  assert.equal(c.native.writes.find(frame=>frame.id==='race-A')?.result,undefined)
})
