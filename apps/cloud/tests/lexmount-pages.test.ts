import assert from 'node:assert/strict';
import {test} from 'node:test';
import {lexmountReader,type LexmountConfig} from '../src/lexmount-pages';
import {extractArticle,extractNotices,type SchoolSource} from '../src/school-pages';
const source:SchoolSource={id:'school_001',name:'合成大学',homepage:'https://www.pku.edu.cn/',announcementUrl:'https://www.pku.edu.cn/notices/'};
const config:LexmountConfig={apiKey:'fixture-lexmount-key-not-real',projectId:'fixture-project',baseUrl:'https://api.lexmount.cn',engine:'auto'};
const resolve=async()=>[{address:'8.8.8.8'}];
const capture=(patch:Record<string,unknown>={})=>({status_code:200,final_url:'https://www.pku.edu.cn/notices/',engine:'lightmount_dcl',dom_id:'synthetic-dom',html:'<article><p>合成学校公开通知：申请人请准备报名材料，核对参与条件、时间及提交方式，并关注审核结果。</p></article>',...patch});

test('Lexmount uses the documented DOM endpoint, server headers and rendered markup with existing parsers',async()=>{
 let calls=0;
 const reader=lexmountReader({config:()=>config,resolve,request:async(url,init)=>{
  calls++;assert.equal(String(url),'https://api.lexmount.cn/v1/dom/dump');assert.equal(init!.method,'POST');assert.equal(init!.redirect,'error');
  const headers=new Headers(init!.headers);assert.equal(headers.get('X-API-Key'),config.apiKey);assert.equal(headers.get('X-Project-Id'),config.projectId);assert.equal(headers.get('cookie'),null);assert.equal(headers.get('authorization'),null);
  assert.deepEqual(JSON.parse(String(init!.body)),{url:source.announcementUrl,options:{engine_preference:'auto',timeout_ms:15000,filter_scripts_styles:true}});
  return Response.json(capture());
 }});
 const page=await reader(source.announcementUrl,source);assert.equal(calls,1);assert.match(extractArticle(page,source),/合成学校/);
 const listReader=lexmountReader({config:()=>config,resolve,request:async()=>Response.json(capture({html:'<ul><li><time>2026-10-25</time><a href="/info/1/12345.htm">合成报名公告通知</a></li></ul>'}))});
 const rows=extractNotices(await listReader(source.announcementUrl,source),source);assert.equal(rows.length,1);assert.equal(rows[0]!.publishedAt,'2026-10-24T16:00:00.000Z');
});
test('unconfigured credentials, nonofficial endpoints and unsafe targets stop before any Lexmount call',async()=>{
 let calls=0;const request=async()=>{calls++;return Response.json(capture());};
 await assert.rejects(()=>lexmountReader({config:()=>({apiKey:'',projectId:''}),resolve,request})(source.announcementUrl,source),{code:'LEXMOUNT_NOT_CONFIGURED'});
 for(const baseUrl of ['http://api.lexmount.cn','https://api.lexmount.cn.evil.example','https://api.lexmount.cn/?secret=x','https://api.lexmount.cn/v1','https://user:pass@api.lexmount.cn'])await assert.rejects(()=>lexmountReader({config:()=>({...config,baseUrl}),resolve,request})(source.announcementUrl,source),{code:'LEXMOUNT_NOT_CONFIGURED'});
 for(const url of ['https://evil.example/','https://www.pku.edu.cn/?token=private','https://127.0.0.1/','https://sso.pku.edu.cn/'])await assert.rejects(()=>lexmountReader({config:()=>config,resolve,request})(url,source));
 await assert.rejects(()=>lexmountReader({config:()=>config,resolve:async()=>[{address:'127.0.0.1'}],request})(source.announcementUrl,source),{code:'SOURCE_RESTRICTED'});
 assert.equal(calls,0);
});
test('final scope, DNS and target HTTP status are checked even when the Lexmount API returns 200',async()=>{
 for(const patch of [{final_url:'https://evil.example/article'},{final_url:'https://cas.pku.edu.cn/login'},{status_code:403},{status_code:404},{status_code:500},{status_code:undefined},{html:''},{final_url:undefined},{error:'provider-failed'}]){
  const reader=lexmountReader({config:()=>config,resolve,request:async()=>Response.json(capture(patch))});await assert.rejects(()=>reader(source.announcementUrl,source));
 }
 let resolutions=0;await assert.rejects(()=>lexmountReader({config:()=>config,resolve:async()=>[{address:++resolutions===1?'8.8.8.8':'10.0.0.1'}],request:async()=>Response.json(capture())})(source.announcementUrl,source),{code:'SOURCE_RESTRICTED'});
});
test('quota, credentials, throttling and provider errors are explicit, redacted and never retried',async()=>{
 for(const [status,body,code] of [[401,{message:'private-'+config.apiKey},'LEXMOUNT_AUTH_FAILED'],[403,{error:{code:'webfetch_quota_exhausted'}},'LEXMOUNT_QUOTA_EXHAUSTED'],[403,{error:'client_ip_geo_blocked'},'LEXMOUNT_REGION_BLOCKED'],[429,{message:'slow down'},'LEXMOUNT_RATE_LIMITED'],[503,{error:'setaria_upstream_failed'},'LEXMOUNT_UNAVAILABLE']] as const){
  let calls=0;const reader=lexmountReader({config:()=>config,resolve,request:async()=>{calls++;return Response.json(body,{status});}});
  await assert.rejects(()=>reader(source.announcementUrl,source),(error:any)=>error.code===code&&!error.message.includes(config.apiKey));assert.equal(calls,1);
 }
});
test('declared/streamed oversize JSON, oversize HTML, bad JSON and stalled response bodies fail safely',async()=>{
 const responses=[new Response('{}',{headers:{'content-length':String(5*1024*1024)}}),new Response('x'.repeat(4*1024*1024+1)),Response.json(capture({html:'字'.repeat(600000)})),new Response('not-json')];
 for(const response of responses)await assert.rejects(()=>lexmountReader({config:()=>config,resolve,request:async()=>response})(source.announcementUrl,source));
 let cancelled=false;const response=new Response(new ReadableStream({cancel(){cancelled=true;}}));
 await assert.rejects(()=>lexmountReader({config:()=>config,resolve,request:async()=>response,timeoutMs:25})(source.announcementUrl,source),{code:'LEXMOUNT_TIMEOUT'});assert.equal(cancelled,true);
});
test('robots and raw feed responses retain existing direct protocol readers without cloud rendering',async()=>{
 let calls=0;const reader=lexmountReader({config:()=>{throw Error('HTML configuration must not be needed');},resolve,request:async()=>{throw Error('Cloud must not be used');},direct:async url=>{calls++;return{url,html:'User-agent: *\nDisallow: /private'};}});
 await reader('https://www.pku.edu.cn/robots.txt',source);await reader(source.announcementUrl,{...source,rawResponse:true});assert.equal(calls,2);
});
