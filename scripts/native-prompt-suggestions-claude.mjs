import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const receiptPath = process.env.NATIVE_SUGGESTIONS_CLAUDE_RECEIPT;
assert.ok(receiptPath, 'TEST runner must select its own receipt destination');
const selected = createRequire(new URL('../packages/provider-implementations/package.json', import.meta.url));
const sdk = await import(pathToFileURL(selected.resolve('@anthropic-ai/claude-agent-sdk')).href);
assert.equal(typeof sdk.query, 'function');
const root = await mkdtemp(join(tmpdir(), 'TEST-claude-native-prompt-suggestion-'));
const workspace = join(root, 'workspace'), home = join(root, 'home'), config = join(root, 'claude');
await Promise.all([workspace,home,config].map(p=>mkdir(p,{recursive:true,mode:0o700})));
const markerA='TEST_CLAUDE_NATIVE_FIRST_508a', markerB='TEST_CLAUDE_NATIVE_SECOND_d3f5';
const candidate='Review the completed tests and open a PR';
let server, nativeQuery;
const requestFacts=[], failures=[], events=[], suggestions=[];
let awakened, done = false;
const inputs=[];
const notify=()=>{awakened?.();awakened=undefined};
async function* inputStream(){
  while(!done){
    if (!inputs.length) await new Promise(resolve=>{awakened=resolve});
    while(inputs.length) yield inputs.shift();
  }
}
function emitSse(response,text,id,model){
  const event=(type,payload)=>response.write('event: '+type+'\ndata: '+JSON.stringify({type,...payload})+'\n\n');
  response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
  event('message_start',{message:{id:'msg_TEST_'+id,type:'message',role:'assistant',
    model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:30,output_tokens:0}}});
  event('content_block_start',{index:0,content_block:{type:'text',text:''}});
  event('content_block_delta',{index:0,delta:{type:'text_delta',text}});
  event('content_block_stop',{index:0});
  event('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:12}});
  event('message_stop',{});
  response.end();
}
async function boundedRead(req){
  const chunks=[];let size=0;
  for await(const raw of req){size+=raw.byteLength;if(size>1024*1024)throw new Error('TEST model request too large');chunks.push(Buffer.from(raw))}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
let summary;
try{
  server=createServer((req,res)=>{
    void(async()=>{
      assert.equal(req.method,'POST');
      assert.ok(req.url?.startsWith('/v1/messages'), 'only local Anthropic Messages API');
      const body=await boundedRead(req);
      const raw=JSON.stringify(body.messages??[]);
      const hasA=raw.includes(markerA), hasB=raw.includes(markerB);
      const ordinal=requestFacts.length+1;
      const isSuggestion=ordinal>2;
      requestFacts.push({hasA,hasB,isSuggestion,tools:Array.isArray(body.tools)?body.tools.length:0});
      if(ordinal>8)throw new Error('unexpected additional model calls');
      if(isSuggestion&&!hasB)throw new Error('suggestion request missing second native user context');
      if(!hasA&&!hasB)throw new Error('unrelated model request or unexpected model context');
      emitSse(res,isSuggestion?candidate:'TEST assistant turn '+ordinal,ordinal,
        typeof body.model==='string'?body.model:'claude-sonnet-4-6');
    })().catch(e=>{
      failures.push(e instanceof Error?e.message:'TEST model failure');
      if(!res.headersSent)res.writeHead(400);
      res.end('TEST local Messages oracle refused input');
    });
  });
  server.requestTimeout=18000;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const baseUrl='http://127.0.0.1:'+address.port;
  const sessionId=randomUUID();
  const env={
    HOME:home,CLAUDE_CONFIG_DIR:config,PATH:process.env.PATH??'/usr/bin:/bin',
    ANTHROPIC_API_KEY:'TEST-LOCALHOST-ONLY',ANTHROPIC_BASE_URL:baseUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',DISABLE_AUTOUPDATER:'1',
    DISABLE_TELEMETRY:'1',NO_COLOR:'1',LANG:'C.UTF-8'
  };
  nativeQuery=sdk.query({prompt:inputStream(),options:{
    cwd:workspace,env,model:'claude-sonnet-4-6',sessionId,
    persistSession:true,includePartialMessages:true,promptSuggestions:true,
    permissionMode:'default',settingSources:[],mcpServers:{},strictMcpConfig:true,
    tools:[],allowedTools:[],maxTurns:1,
  }});
  const push=(text)=>{inputs.push({type:'user',message:{role:'user',content:text},
    parent_tool_use_id:null,session_id:sessionId,uuid:randomUUID()});notify()};
  const read=(async()=>{
    for await(const message of nativeQuery){
      const msg=message??{};
      const type=typeof msg.type==='string'?msg.type:'unknown';
      events.push(type);
      if(events.length>100)throw new Error('native SDK emitted too many events');
      if(msg.type==='result'){
        const failures=['error_during_execution','error_max_turns','error_max_budget_usd'];
        if(msg.is_error===true||failures.includes(msg.subtype))throw new Error('native Claude returned an error result');
      }
      if(msg.type==='prompt_suggestion'){
        suggestions.push({session:msg.session_id===sessionId,text:msg.suggestion});
        if(suggestions.length>2)throw new Error('duplicate suggestion amplification');
      }
      if(msg.type==='result'&&events.filter(x=>x==='result').length===1){
        push(markerB);
      }
      if(suggestions.length&&events.filter(x=>x==='result').length>=2)break;
    }
  })();
  push(markerA);
  const timeout=new Promise((_resolve,reject)=>setTimeout(()=>reject(new Error('native suggestion timeout')),40000));
  await Promise.race([read,timeout]);
  assert.equal(events.filter(x=>x==='result').length,2,'two actual SDK turns completed');
  assert.ok(suggestions.some(x=>x.session&&typeof x.text==='string'&&x.text.trim().length>0));
  assert.equal(failures.length,0);
  assert.ok(requestFacts.filter(x=>x.hasB).length>0);
  summary={passed:true,provider:'claude',nativeSdk:'0.3.305',nativeResults:2,
    nativeSuggestionEvents:suggestions.length,inheritedContext:requestFacts.some(x=>x.isSuggestion&&x.hasA&&x.hasB),
    modelRequests:requestFacts.length,toolCalls:0,vendorAuth:false,
    model:'localhost-scripted-anthropic-messages',environment:process.platform+'-'+process.arch};
}catch(e){
  summary={passed:false,provider:'claude',nativeSdk:'0.3.305',
    reason:e instanceof Error?e.message.slice(0,240):'unknown',eventTypes:events.slice(-12),
    nativeResults:events.filter(x=>x==='result').length,nativeSuggestionEvents:suggestions.length,
    modelRequests:requestFacts.length,fixtureErrors:failures.slice(0,4),vendorAuth:false,
    environment:process.platform+'-'+process.arch};
}finally{
  done=true;notify();
  try{nativeQuery?.close()}catch{}
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
  await rm(root,{recursive:true,force:true});
}
await writeFile(receiptPath,JSON.stringify(summary,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(summary));
if(!summary.passed)process.exitCode=1;
