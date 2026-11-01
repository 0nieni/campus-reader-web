import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {deepseekSearchKey,deepseekSearchPublicWeb,readDeepseekPublicPage} from '../src/deepseek-search';
import {extractArticle} from '../src/school-pages';
import {publicSearchSource} from '../src/public-search-page';
import {assistantService} from '../src/assistant-service';
import {aiService} from '../src/ai-service';
import {fixtureDb,identity} from './feature-fixture';
import type {AiRecommendations} from '@campus/contracts';

const school={id:'bjtu',name:'北京交通大学'},key='fixture-deepseek-key';
test('search reuses only official backend DeepSeek credentials, never an OpenAI/relay or personal profile key',()=>{
  assert.equal(deepseekSearchKey({AI_CHAT_API_KEY:key}),key);
  for(const base of ['https://api.deepseek.com','https://api.deepseek.com/v1','https://api.deepseek.com/v1/chat/completions'])assert.equal(deepseekSearchKey({AI_CHAT_API_KEY:key,AI_CHAT_BASE_URL:base}),key);
  for(const base of ['http://api.deepseek.com','https://api.openai.com/v1','https://relay.example/v1','https://api.deepseek.com@evil.example','https://api.deepseek.com/v1?token=x'])assert.equal(deepseekSearchKey({AI_CHAT_API_KEY:key,AI_CHAT_BASE_URL:base}),null);
  assert.equal(deepseekSearchKey({TAVILY_API_KEY:'old-key'}),null);assert.equal(deepseekSearchKey({AI_CHAT_API_KEY:'bad key'}),null);
});
test('Search uses the fixed official endpoint, 128 Unicode query limit, scoped school words and bounded deduplicated clues',async()=>{
  const result=await deepseekSearchPublicWeb(school,'本校比赛 '+ '😀'.repeat(200),{apiKey:key,fetch:async(url,init)=>{
    assert.equal(String(url),'https://api.deepseek.com/v1/tools/search');assert.equal(init?.redirect,'error');assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${key}`);
    const body=JSON.parse(String(init?.body));assert.equal(Array.from(body.query).length,128);assert.match(body.query,/北京交通大学/);assert.equal(body.count,5);assert.equal(body.need_content,false);assert.deepEqual(Object.keys(body).sort(),['count','need_content','query']);
    return Response.json({results:[{title:'公开资料',url:'https://public.example/one#anchor',snippet:'仅线索',content:'正文不得从 Search 读取',summary:'摘要不当正文'},{title:'重复',url:'https://public.example/one'},{title:'内网',url:'https://127.0.0.1/a'},{title:'凭据链接',url:'https://public.example/secret?apiKey=x'},...Array.from({length:8},(_,i)=>({title:'题'.repeat(300),url:`https://other.example/${i}`}))]});
  }});
  assert.equal(result.state,'complete');assert.equal(result.candidates.length,5);assert.equal(result.candidates[0].snippet,'仅线索');assert.ok(!JSON.stringify(result).includes('正文不得'));
});
test('Search reports absent credentials, provider codes, empty results and invalid responses without private diagnostics',async()=>{
  assert.equal((await deepseekSearchPublicWeb(school,'query',{apiKey:'',fetch:async()=>{throw Error('must not call');}})).state,'unconfigured');
  for(const [status,code] of [[401,'authorization'],[403,'authorization'],[402,'quota'],[429,'rate_limited'],[500,'provider']] as const){
    const result=await deepseekSearchPublicWeb(school,'query',{apiKey:key,fetch:async()=>new Response('private upstream secret',{status})});assert.equal(result.code,code);assert.ok(!JSON.stringify(result).includes('private upstream'));
  }
  const empty=await deepseekSearchPublicWeb(school,'query',{apiKey:key,fetch:async()=>Response.json({results:[]})});assert.equal(empty.state,'complete');assert.equal(empty.candidates.length,0);
  const large=await deepseekSearchPublicWeb(school,'query',{apiKey:key,fetch:async()=>new Response('secret',{headers:{'content-length':'524289'}})});assert.equal(large.code,'invalid_response');
  const privateQuery=await deepseekSearchPublicWeb(school,'请查询 person@example.com',{apiKey:key,fetch:async()=>{throw Error('must not send');}});assert.equal(privateQuery.state,'failed');
});
test('Fetch follows robots and public DNS checks, sends credentials only to DeepSeek, and supplies escaped body evidence',async()=>{
  const url='https://public.example/article';let calls=0;
  const page=await readDeepseekPublicPage(url,{apiKey:key,pause:async()=>{},redirectOptions:{lookup:async()=>[{address:'8.8.8.8'}],head:async()=>({status:200})},robotsReader:async(target)=>{assert.equal(target,'https://public.example/robots.txt');return{url:target,html:'User-agent: *\nAllow: /'};},fetch:async(target,init)=>{
    calls++;assert.equal(String(target),'https://api.deepseek.com/v1/tools/fetch');assert.deepEqual(JSON.parse(String(init?.body)),{url});assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${key}`);
    return Response.json({title:'公开网页',content:'这里是实际取得的公开网页正文，用于验证引用和来源。<script>网页脚本不能执行</script> 请根据正文核对。'});
  }});
  assert.equal(calls,1);assert.ok(!page.html.includes('<script>'));assert.match(extractArticle(page,publicSearchSource(url)),/实际取得的公开网页正文/);
  for(const denied of ['robots','dns']){
    calls=0;await assert.rejects(readDeepseekPublicPage(url,{apiKey:key,pause:async()=>{},redirectOptions:{lookup:async()=>[{address:'10.0.0.1'}],head:async()=>({status:200})},robotsReader:async target=>({url:target,html:denied==='robots'?'User-agent: *\nDisallow: /':'User-agent: *\nAllow: /'}),fetch:async()=>{calls++;throw Error('must not fetch');}}));assert.equal(calls,0);
  }
});
test('the default production assistant routes search to DeepSeek without Tavily and reuses authorized existing evidence',async()=>{
  const f=fixtureDb(),saved={key:process.env.AI_CHAT_API_KEY,base:process.env.AI_CHAT_BASE_URL};let requests=0;
  process.env.AI_CHAT_API_KEY=key;process.env.AI_CHAT_BASE_URL='https://api.deepseek.com';
  mock.method(globalThis,'fetch',async(target:any)=>{requests++;assert.equal(String(target),'https://api.deepseek.com/v1/tools/search');return Response.json({results:[{title:'测试竞赛',url:'https://www.bjtu.edu.cn/test',snippet:'线索'}]});});
  try{
    const ai=aiService(f.db,f.repo),assistant=assistantService(f.db,f.repo,ai);
    const status=await ai.handle('ai.status',{},identity) as any;assert.equal(status.searchConfigured,true);
    const result=await assistant.handle('ai.recommend',{schoolId:'bjtu',query:'本校比赛',search:true},identity) as AiRecommendations;
    assert.equal(result.search.state,'complete');assert.equal(result.search.readableCount,1);assert.equal(result.items[0].id,'notice');assert.equal(requests,1);
  }finally{mock.restoreAll();if(saved.key===undefined)delete process.env.AI_CHAT_API_KEY;else process.env.AI_CHAT_API_KEY=saved.key;if(saved.base===undefined)delete process.env.AI_CHAT_BASE_URL;else process.env.AI_CHAT_BASE_URL=saved.base;}
});
test('DeepSeek Search and Fetch feed the current scoped evidence store, with snippets excluded and a fixed expiry',async()=>{
  const f=fixtureDb(),target='https://public.example/guide';let searches=0,reads=0;
  const request:typeof fetch=async(url)=>{
    if(String(url).endsWith('/search')){searches++;return Response.json({results:[{title:'公开资料',url:target,snippet:'不可当正文的摘要'}]});}
    reads++;return Response.json({content:'这是一篇实际读取的公开页面正文，说明报名需要核对资格和准备材料，具体日期以原文最新说明为准。'});
  };
  const assistant=assistantService(f.db,f.repo,aiService(f.db,f.repo),Date.now,(school,query)=>deepseekSearchPublicWeb(school,query,{apiKey:key,fetch:request}),url=>readDeepseekPublicPage(url,{apiKey:key,fetch:request,redirectOptions:{lookup:async()=>[{address:'8.8.8.8'}],head:async()=>({status:200})},pause:async()=>{},robotsReader:async url=>({url,html:'User-agent: *\nAllow: /'})}));
  const result=await assistant.handle('ai.recommend',{schoolId:'bjtu',query:'公开资料',search:true},identity) as AiRecommendations;
  const card=result.items.find(item=>item.originalUrl===target)!;assert.equal(card.readState,'body');assert.equal(card.allowAi,true);
  const stored=f.rows('items').get(card.id)!;assert.match(stored.contentText,/实际读取/);assert.ok(!stored.contentText.includes('不可当正文的摘要'));assert.equal(stored.ownerOpenid,identity.dataOwnerId);assert.ok(Date.parse(stored.aiSearchExpiresAt)>Date.now());assert.equal(searches,1);assert.equal(reads,1);
});
test('the Search deadline bounds a stalled provider call and never returns partial evidence',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  try{
    let signal:AbortSignal|undefined;
    const pending=deepseekSearchPublicWeb(school,'公开资料',{apiKey:key,fetch:async(_url,init)=>{signal=init?.signal as AbortSignal;return new Promise<Response>(()=>{});}});
    context.mock.timers.tick(8000);const result=await pending;assert.equal(result.code,'timeout');assert.equal(signal?.aborted,true);assert.equal(result.candidates.length,0);
  }finally{context.mock.timers.reset();}
});
