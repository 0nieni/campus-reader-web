import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {AiConversation,AiChatTurn} from '@campus/contracts';
import {fixtureDb,identity} from './feature-fixture';
import {aiService} from '../src/ai-service';
import {assistantChat} from '../src/assistant-chat';
import {webReading} from '../src/web-reading';
import {reserveSearch} from '../src/search-budget';
import type {ChatReply} from '../src/model-provider';
import {identify} from '../src/identity';

function setup(options:{holdPlanner?:()=>Promise<void>;uncertain?:boolean;afterSearch?:()=>Promise<void>}={}){
  const f=fixtureDb();let clock=Date.now(),models=0,searches=0;
  process.env.AI_CHAT_BASE_URL='https://api.deepseek.com';process.env.AI_CHAT_MODEL='fixture-model';process.env.AI_CHAT_API_KEY='fixture-key';process.env.AI_EXECUTION_MODE='direct';process.env.AI_DAILY_LIMIT='3';
  const ai=aiService(f.db,f.repo,async()=> '校园材料 [R1](https://www.bjtu.edu.cn/test)',()=>clock,undefined,async input=>webReading(input,{
    chat:async(_connection,_messages,_tokens,_endpoint,opts):Promise<ChatReply>=>{
      models++;
      if(opts?.toolChoice==='auto'){await options.holdPlanner?.();return{finishReason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'fixture-call',type:'function',function:{name:'web_search',arguments:'{"query":"公开主题"}'}}]}};}
      if(options.uncertain)throw Object.assign(new Error('private raw timeout'),{code:'MODEL_UNCERTAIN'});
      return{finishReason:'stop',message:{role:'assistant',content:`正文资料 [R${input.docs.length+1}](https://public.example/article)`}};
    },
    search:async(query,_key,opts)=>{await opts?.assertActive?.();await opts?.beforeSearch?.();searches++;await options.afterSearch?.();return{state:'complete',message:'已读取公开网页正文摘录',query,sources:[{title:'公开网页',url:'https://public.example/article',readState:'body',checkedAt:new Date(clock).toISOString(),publishedAt:null,body:'保留在本人本轮任务中的公开网页摘录'}]};}
  }));
  const chat=assistantChat(f.db,f.repo,ai,async()=>{throw Error('web turn must not auto-select campus recommendations');},()=>clock,async()=>{throw Error('web turn must not use legacy discovery');});
  const call=(action:string,input:Record<string,unknown>,who=identity)=>chat.handle(action,input,who);
  const create=async()=>await call('ai.chat.create',{schoolId:'bjtu',requestId:'web-conversation-0001'}) as AiConversation;
  const send=async(c:AiConversation,extra:Record<string,unknown>={})=>await call('ai.chat.send',{conversationId:c.id,requestId:'web-question-request-001',question:'搜索整个互联网的公开资料',webSearch:true,...extra}) as AiChatTurn;
  const finish=async(c:AiConversation,turn:AiChatTurn)=>{while(turn.state==='ready')turn=await call('ai.chat.step',{conversationId:c.id,turnId:turn.id,step:turn.step}) as AiChatTurn;return turn;};
  return{...f,ai,call,create,send,finish,models:()=>models,searches:()=>searches,advance:(ms:number)=>{clock+=ms;},clock:()=>clock};
}

test('web-only conversations use one successful reply quota, deduplicate sends/steps, isolate owners and expire all web evidence',async()=>{
  const f=setup(),c=await f.create(),t=await f.send(c);
  assert.equal(t.totalSteps,1);assert.equal(f.models(),0);
  assert.equal((await f.send(c)).taskId,t.taskId);
  await assert.rejects(f.send(c,{webSearch:false}),{code:'REQUEST_CONFLICT'});
  const done=await f.finish(c,t);assert.equal(done.state,'complete');assert.equal(done.webSearch?.sources[0].reference,'R1');
  assert.equal(f.models(),2);assert.equal(f.searches(),1);
  await f.call('ai.chat.step',{conversationId:c.id,turnId:t.id,step:0});assert.equal(f.models(),2);
  const status=await f.ai.handle('ai.status',{},identity) as any;assert.equal(status.quota.used,1);assert.equal(status.quota.held,0);assert.equal(status.webSearchConfigured,true);
  const stored=f.rows('web_ai_tasks').get(t.taskId!)!;assert.equal(stored.webEvidence.length,1);assert.equal(stored.docs.length,0);
  assert.ok(!JSON.stringify(stored).includes('fixture-key'));assert.ok(!JSON.stringify(done).includes('保留在本人本轮任务'));
  assert.equal(f.items.size,1,'web sources must not become shared announcements');
  const other=identify({uid:'different-owner',isAnonymous:false},{ownerUid:'different-owner'});
  await assert.rejects(f.call('ai.chat.get',{conversationId:c.id},other),{code:'NOT_FOUND'});
  f.advance(86400001);await assert.rejects(f.call('ai.chat.get',{conversationId:c.id}),{code:'RESULT_EXPIRED'});
  const expired=f.rows('web_ai_tasks').get(t.taskId!)!;assert.equal(expired.webEvidence,undefined);assert.equal(expired.webSearch,undefined);
});

test('campus plus public web retains distinct references and rechecks school selection before final answer',async()=>{
  const f=setup(),c=await f.create(),t=await f.send(c,{itemIds:['notice']});
  const done=await f.finish(c,t);assert.equal(done.state,'complete');assert.equal(done.references[0].reference,'R1');assert.equal(done.webSearch?.sources[0].reference,'R2');
  let g:ReturnType<typeof setup>;
  g=setup({afterSearch:async()=>{await g.repo.selectSchool(identity.dataOwnerId,'other');}});
  const gc=await g.create(),gt=await g.send(gc);
  await assert.rejects(g.finish(gc,gt),{code:'STALE_SCOPE'});assert.equal(g.models(),1,'scope changed after search must block final model');
});

test('cancellation during planning stops search/final model and concurrent steps cannot duplicate calls',async()=>{
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});
  const f=setup({holdPlanner:async()=>{entered();await wait;}}),c=await f.create(),t=await f.send(c);
  const running=f.finish(c,t);await ready;
  const duplicate=await f.call('ai.chat.step',{conversationId:c.id,turnId:t.id,step:0}) as AiChatTurn;assert.equal(duplicate.state,'running');
  await f.call('ai.chat.cancel',{conversationId:c.id,turnId:t.id});release();
  const stopped=await running;assert.equal(stopped.state,'cancelled');assert.equal(f.models(),1);assert.equal(f.searches(),0);assert.equal(stopped.quotaHeld,false);
});

test('unknown final outcomes retain sources and quota, pause on refresh and never replay a search',async()=>{
  const f=setup({uncertain:true}),c=await f.create(),t=await f.send(c),done=await f.finish(c,t);
  assert.equal(done.state,'uncertain');assert.equal(done.quotaHeld,true);assert.equal(done.webSearch?.sources.length,1);
  const refreshed=await f.call('ai.chat.get',{conversationId:c.id}) as AiConversation;assert.equal(refreshed.turns[0].state,'uncertain');
  await f.call('ai.chat.step',{conversationId:c.id,turnId:t.id,step:0});assert.equal(f.models(),2);assert.equal(f.searches(),1);
  assert.ok(!JSON.stringify(done).includes('private raw'));
});

test('external searches share the account ledger; OpenAI web mode fails before reserving or sending',async()=>{
  const f=setup();await reserveSearch(f.db,identity.dataOwnerId,f.clock());
  await assert.rejects(reserveSearch(f.db,identity.dataOwnerId,f.clock()),{code:'SEARCH_LIMIT'});
  f.advance(15000);await reserveSearch(f.db,identity.dataOwnerId,f.clock());
  const c=await f.create();await assert.rejects(f.send(c,{service:'byok',provider:'openai',model:'fixture-openai'}),{code:'WEB_SEARCH_UNSUPPORTED'});
  assert.equal(f.models(),0);assert.equal((await f.ai.handle('ai.status',{},identity) as any).quota.held,0);
});
