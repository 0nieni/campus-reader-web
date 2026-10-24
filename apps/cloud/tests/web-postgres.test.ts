import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import type {AiChatTurn,AiConversation,GatewayResult} from '@campus/contracts';
import {postgresStorage,type SqlPool} from '../src/postgres-storage';
import {postgresRepository} from '../src/postgres-repository';
import {createGateway} from '../src/gateway';
import {aiService} from '../src/ai-service';
import {assistantService} from '../src/assistant-service';
import {cleanupAssistantData} from '../src/assistant-cleanup';
import {reserveSearch} from '../src/search-budget';

test('local SQL web evidence stays private, search ledger serializes and scheduled cleanup removes bodies',async()=>{
  const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),pool=getDatabase({connectionString}).pool;
  (pool as unknown as {options:{max:number}}).options.max=1;
  const sql=pool as unknown as SqlPool,db=postgresStorage(sql),repo=postgresRepository(sql);let clock=Date.now(),calls=0;
  process.env.AI_CHAT_BASE_URL='https://api.deepseek.com';process.env.AI_CHAT_MODEL='fixture-model';process.env.AI_CHAT_API_KEY='fixture-key';process.env.AI_EXECUTION_MODE='direct';
  const ai=aiService(db,repo,undefined,()=>clock,undefined,async input=>{
    calls++;await input.assertActive();await input.beforeSearch();
    const state={state:'complete' as const,message:'已读取公开网页摘录',query:'fixture query',sources:[{reference:'R1',title:'公开页',url:'https://public.example/article',readState:'body' as const,checkedAt:new Date(clock).toISOString(),publishedAt:null}]};
    const docs=[{reference:'R1',itemId:'web-fixture',schoolId:null,title:'公开页',originalUrl:'https://public.example/article',version:'v1',markdown:'fixture-private-evidence'}];
    await input.saveEvidence(state,docs);return{text:'公开资料 [R1](https://public.example/article)',state,docs};
  });
  const assistant=assistantService(db,repo,ai,()=>clock),actor={uid:'sql-web-owner',isAnonymous:false};
  const gateway=createGateway(repo,{ownerUid:actor.uid,dataOwnerId:actor.uid},()=>clock,{ai:{handle:(a,i,id)=>assistant.supports(a)?assistant.handle(a,i,id):ai.handle(a,i,id)}});
  const call=(action:string,input:Record<string,unknown>={})=>gateway({action,input},actor);
  const data=<T>(v:GatewayResult<unknown>):T=>{assert.ok(v.ok,JSON.stringify(v));return v.data as T;};
  try{
    await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));
    data(await call('school.select',{schoolId:'bjtu'}));
    const beforeItems=Number((await sql.query("SELECT count(*) AS count FROM campus_documents WHERE collection='items'")).rows[0].count);
    const c=data<AiConversation>(await call('ai.chat.create',{schoolId:'bjtu',requestId:'sql-web-conversation-001'}));
    const input={conversationId:c.id,requestId:'sql-web-question-001',question:'查公开资料',webSearch:true};
    const [first,duplicate]=await Promise.all([call('ai.chat.send',input),call('ai.chat.send',input)]);
    const turn=data<AiChatTurn>(first);assert.equal(data<AiChatTurn>(duplicate).id,turn.id);assert.equal(calls,0);
    const done=data<AiChatTurn>(await call('ai.chat.step',{conversationId:c.id,turnId:turn.id,step:0}));
    assert.equal(done.state,'complete');assert.equal(done.webSearch?.sources[0].reference,'R1');assert.equal(calls,1);
    const row=(await sql.query("SELECT body FROM campus_documents WHERE collection='web_ai_tasks' AND id=$1",[turn.taskId])).rows[0].body;
    assert.equal(row.webEvidence[0].markdown,'fixture-private-evidence');assert.equal(row.docs.length,0);
    assert.ok(!JSON.stringify(done).includes('fixture-private-evidence'));
    const count=(await sql.query("SELECT count(*) AS count FROM campus_documents WHERE collection='items'")).rows[0].count;
    assert.equal(Number(count),beforeItems);
    clock+=15000;
    const budgets=await Promise.allSettled([reserveSearch(db,actor.uid,clock),reserveSearch(db,actor.uid,clock)]);
    assert.equal(budgets.filter(v=>v.status==='fulfilled').length,1);
    assert.equal((budgets.find(v=>v.status==='rejected') as PromiseRejectedResult).reason.code,'SEARCH_LIMIT');
    clock+=86400001;await cleanupAssistantData(sql,clock);
    const purged=(await sql.query("SELECT body FROM campus_documents WHERE collection='web_ai_tasks' AND id=$1",[turn.taskId])).rows[0].body;
    assert.equal(purged.webEvidence,undefined);assert.equal(purged.webSearch,undefined);assert.equal(purged.purged,true);
    const expired=await call('ai.chat.get',{conversationId:c.id});assert.ok(!expired.ok&&expired.code==='RESULT_EXPIRED');
  }finally{await pool.end();await server.stop();}
});
