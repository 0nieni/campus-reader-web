import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
import {getStore} from '@netlify/blobs';
import {minuteTick,refreshWake,replaceWake,type WakeStore,type WakeValue} from '../src/reminder-index';
import {createMinuteTrigger,triggerSignature,reminderTickUrl} from '../src/reminder-trigger';
export function memoryWake():WakeStore {
 let value:WakeValue|null=null,version=0;
 return{async read(){return value?{value:structuredClone(value),etag:String(version)}:null;},async write(next,etag){if(etag!==(value?String(version):null))return false;value=structuredClone(next);version++;return true;}};
}
test('locked Blobs SDK uses strong read and reports CAS conflicts rather than unconditional success',async()=>{
 let value:any=null,etag=0;const seen:Record<string,string>[]=[];
 const store=getStore({name:'synthetic-reminder-prototype',siteID:'synthetic-site',token:'synthetic-token',apiURL:'https://synthetic.invalid',consistency:'strong',fetch:async(input,init)=>{
  const request=new Request(input,init),headers=Object.fromEntries(request.headers);seen.push(headers);
  if(headers.accept==='application/json;type=signed-url')return Response.json({url:'https://synthetic.invalid/object'});
  if(request.method==='GET')return value===null?new Response(null,{status:404}):Response.json(value,{headers:{etag:String(etag)}});
  if(request.method==='PUT'){
   if(headers['if-none-match']==='*'&&value!==null||headers['if-match']!==undefined&&headers['if-match']!==String(etag))return new Response(null,{status:412});
   value=JSON.parse(await request.text());etag++;return new Response(null,{headers:{etag:String(etag)}});
  }throw Error('Unexpected SDK method');
 }});
 assert.equal((await store.setJSON('wake',{at:10},{onlyIfNew:true})).modified,true);
 const read=await store.getWithMetadata('wake',{type:'json',consistency:'strong'});assert.equal(read?.data.at,10);assert.equal(read?.etag,'1');
 assert.equal((await store.setJSON('wake',{at:20},{onlyIfMatch:'stale'})).modified,false);
 assert.equal((await store.setJSON('wake',{at:5},{onlyIfMatch:read!.etag!})).modified,true);
 assert.ok(seen.some(h=>h['if-match']==='stale'));assert.equal((await store.get('wake',{type:'json',consistency:'strong'})).at,5);
});
test('1,440 empty minute ticks and an unavailable index never access SQL',async()=>{
 const store=memoryWake();await replaceWake(store,null,null);let queries=0,time=Date.now();
 for(let i=0;i<1440;i++){await minuteTick({store,now:()=>time+i*60000,process:async()=>{queries++;}});}
 assert.equal(queries,0);await assert.rejects(minuteTick({store:memoryWake(),process:async()=>{queries++;}}));assert.equal(queries,0);
});
test('consumer CAS cannot overwrite a concurrently registered earlier deadline; ambiguous writes require readback',async()=>{
 const store=memoryWake();await replaceWake(store,null,9000);let rows=[{next_at:new Date(8000).toISOString()}],once=true;
 const sql={query:async(query:string)=>{
  if(query.startsWith('SELECT')){const result=rows;if(once){once=false;const before=await store.read();await replaceWake(store,before,1000);rows=[{next_at:new Date(1000).toISOString()}];}return{rows:result};}return{rows:[]};
 }} as any;
 await refreshWake(sql,store);assert.equal((await store.read())!.value.nextAt,1000);
 const uncertain:WakeStore={read:()=>store.read(),async write(value,etag){await store.write(value,etag);throw Error('synthetic timeout after commit');}};
 assert.equal(await replaceWake(uncertain,await store.read(),500),true);
 const failed:WakeStore={read:()=>store.read(),async write(){throw Error('synthetic outage');}};await assert.rejects(replaceWake(failed,await store.read(),100));
});
test('FC signatures bind method, path, raw body, ID and freshness, support rotation and isolate previews',async()=>{
 const secret='synthetic-secret-'.repeat(3),time=Date.now(),timestamp=String(time),id='a'.repeat(32);let called=0;
 const create=(production=true)=>createMinuteTrigger({production:()=>production,enabled:()=>true,secrets:()=>[secret,'next-synthetic-secret-'.repeat(3)],now:()=>time,run:async()=>{called++;}});
 const req=(body='{}',overrides:Record<string,string>={},url=reminderTickUrl,key=secret)=>new Request(url,{method:'POST',headers:{'content-type':'application/json','x-reminder-time':timestamp,'x-reminder-request':id,'x-reminder-signature':triggerSignature(key,timestamp,id,'{}'),...overrides},body});
 for(const request of [req('{ }'),req('{}',{'x-reminder-time':String(time-180000)}),req('{}',{'x-reminder-request':'b'.repeat(32)}),req('{}',{},reminderTickUrl+'?spoof=1')])assert.equal((await create()(request)).status,401);
 assert.equal(called,0);assert.equal((await create(false)(req())).status,503);assert.equal(called,0);
 assert.equal((await create()(req())).status,204);assert.equal((await create()(req('{}',{},reminderTickUrl,'next-synthetic-secret-'.repeat(3)))).status,204);assert.equal(called,2);
});
test('deployable FC client signs the fixed endpoint and propagates failure without logging credentials',async()=>{
 const secret='synthetic-fc-secret-'.repeat(3),logs:string[]=[],exported:{handler?:()=>Promise<unknown>}={};let status=204;
 const endpoint=createMinuteTrigger({production:()=>true,enabled:()=>true,secrets:()=>[secret],run:async()=>{}});
 runInNewContext(readFileSync(new URL('../../../infra/aliyun/reminder-tick.cjs',import.meta.url),'utf8'),{exports:exported,require:createRequire(import.meta.url),process:{env:{REMINDER_TRIGGER_SECRET:secret,REMINDER_TICK_URL:reminderTickUrl}},URL,Date,AbortSignal,console:{info:(s:string)=>logs.push(s)},fetch:async(url:string,init:RequestInit)=>{assert.equal(url,reminderTickUrl);assert.equal(init.redirect,'error');assert.equal(await(await endpoint(new Request(url,init))).status,204);return new Response(null,{status});}});
 await exported.handler!();status=503;await assert.rejects(exported.handler!());assert.ok(logs.every(line=>!line.includes(secret)));
});
