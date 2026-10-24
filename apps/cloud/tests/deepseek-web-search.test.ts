import assert from 'node:assert/strict';
import {test} from 'node:test';
import {deepseekWebSearch, publicWebUrl} from '../src/deepseek-web-search';

test('web URLs exclude credentials, local addresses, unsafe schemes and login endpoints',()=>{
  for(const value of ['http://127.0.0.1/a','https://169.254.169.254/latest','https://user:pass@site.example/a','file:///tmp/a','https://localhost/a','https://vpn.school.edu.cn/a','https://site.example:9443/a','https://site.example/a?apiKey=private','https://site.example/a?sessionId=private']) assert.equal(publicWebUrl(value),null,value);
  assert.equal(publicWebUrl('https://news.example/article#section'),'https://news.example/article');
});

test('DeepSeek search/fetch stay on fixed endpoints, fetch at most three deduplicated public results, and never use snippets as bodies',async()=>{
  const calls:Array<{url:string;body:any}>=[];
  const request:typeof fetch=async(target,options)=>{
    assert.equal((options?.headers as Record<string,string>).authorization,'Bearer fixture-only-key');
    assert.equal(options?.redirect,'error');
    const url=String(target),body=JSON.parse(String(options?.body));calls.push({url,body});
    if(url.endsWith('/search'))return Response.json({results:[
      {title:'A',url:'https://one.example/a',summary:'summary must not become source body'},
      {title:'same',url:'https://one.example/a#other'},
      {title:'unsafe',url:'https://127.0.0.1/a'},
      {title:'B',url:'https://two.example/b',snippet:'search snippet'},
      {title:'C',url:'https://three.example/c'},
      {title:'D',url:'https://four.example/d'},
    ]});
    return body.url.includes('two.example')?new Response('',{status:404}):Response.json({title:'Fetched page',content:'Actual public page body with enough text to be used as evidence.'});
  };
  const result=await deepseekWebSearch('公开资料', 'fixture-only-key',{fetch:request,lookup:async()=>[{address:'8.8.8.8',family:4}]});
  assert.equal(result.state,'complete');assert.equal(result.sources.length,3);
  assert.equal(result.sources.filter(s=>s.body).length,2);
  assert.ok(result.sources.every(s=>!s.body?.includes('summary must')));
  assert.equal(calls.length,4);
  assert.ok(calls.every(c=>['https://api.deepseek.com/v1/tools/search','https://api.deepseek.com/v1/tools/fetch'].includes(c.url)));
  assert.equal(calls[0].body.count,5);assert.equal(calls[0].body.need_content,false);
});

test('missing keys, upstream errors and no matches remain explicit without exposing provider responses',async()=>{
  const options={lookup:async()=>[{address:'8.8.8.8',family:4}]};
  assert.equal((await deepseekWebSearch('test','',{...options,fetch:async()=>{throw Error('must not call');}})).state,'unconfigured');
  const failed=await deepseekWebSearch('test','fixture-key',{...options,fetch:async()=>new Response('secret diagnostic',{status:402})});
  assert.equal(failed.state,'failed');assert.ok(!JSON.stringify(failed).includes('secret diagnostic'));
  const empty=await deepseekWebSearch('test','fixture-key',{...options,fetch:async()=>Response.json({results:[]})});
  assert.equal(empty.state,'complete');assert.equal(empty.sources.length,0);
});

test('DNS private resolutions are excluded before any Fetch request',async()=>{
  let fetches=0;
  const result=await deepseekWebSearch('test','fixture-key',{lookup:async()=>[{address:'10.0.0.3',family:4}],fetch:async(target)=>{
    if(String(target).endsWith('/search'))return Response.json({results:[{title:'Internal alias',url:'https://private.example/a'}]});
    fetches++;throw Error('private target must not be fetched');
  }});
  assert.equal(fetches,0);assert.equal(result.sources.length,0);
});

test('cancellation after Search prevents all Fetch calls, and private query values never leave the server',async()=>{
  let stopped=false,calls=0;
  await assert.rejects(deepseekWebSearch('公开资料','fixture-key',{assertActive:async()=>{if(stopped)throw Object.assign(Error('cancelled'),{code:'TASK_CANCELLED'});},lookup:async()=>[{address:'8.8.8.8',family:4}],fetch:async()=>{
    calls++;stopped=true;return Response.json({results:[{title:'A',url:'https://one.example/a'}]});
  }}),{code:'TASK_CANCELLED'});
  assert.equal(calls,1);
  const privateQuery=await deepseekWebSearch('请检索 person@example.com 的资料','fixture-key',{fetch:async()=>{calls++;throw Error('must not send private search');}});
  assert.equal(privateQuery.state,'failed');assert.equal(calls,1);
});

test('oversized API responses are bounded and do not become evidence',async()=>{
  const result=await deepseekWebSearch('公开资料','fixture-key',{fetch:async()=>new Response('private response',{headers:{'content-length':'256001'}})});
  assert.equal(result.state,'failed');assert.equal(result.sources.length,0);assert.ok(!JSON.stringify(result).includes('private response'));
});

test('network errors with codes are search failures rather than unknown model outcomes',async()=>{
  const result=await deepseekWebSearch('公开资料','fixture-key',{fetch:async()=>{throw Object.assign(Error('private diagnostic'),{code:'ECONNRESET'});}});
  assert.equal(result.state,'failed');assert.ok(!JSON.stringify(result).includes('private diagnostic'));
});
