import assert from 'node:assert/strict';
import {test} from 'node:test';
import {lexmountConfigurationStatus,lexmountReader,type LexmountConfig} from '../src/lexmount-pages';
import {withCollectionHealth} from '../src/collection-health';

const config:LexmountConfig={apiKey:'fixture-key-never-output',projectId:'fixture-project'};
test('configuration diagnostics identify missing and malformed fields without exposing values',()=>{
 assert.deepEqual(lexmountConfigurationStatus({apiKey:'',projectId:''}),{configured:false,issues:['LEXMOUNT_API_KEY_MISSING','LEXMOUNT_PROJECT_ID_MISSING']});
 for(const [patch,issue] of [[{projectId:'bad/project-private-sentinel'},'LEXMOUNT_PROJECT_ID_FORMAT'],[{apiKey:'fixture\nkey'},'LEXMOUNT_API_KEY_FORMAT'],[{baseUrl:'https://api.lexmount.cn/?token=private-sentinel'},'LEXMOUNT_WEBFETCH_BASE_URL_INVALID'],[{engine:'wrong-private-engine'},'LEXMOUNT_WEBFETCH_ENGINE_INVALID']] as const){
  const report=lexmountConfigurationStatus({...config,...patch});assert.equal(report.configured,false);assert.deepEqual(report.issues,[issue]);
  const text=JSON.stringify(report);assert.ok(!text.includes(config.apiKey));assert.ok(!text.includes(Object.values(patch)[0]));
 }
 assert.deepEqual(lexmountConfigurationStatus(config),{configured:true,issues:[]});
});
test('a configuration failure names the actual field and stops before a provider request',async()=>{
 let reads=0;const reader=lexmountReader({config:()=>({...config,projectId:'bad/project-private-sentinel'}),request:async()=>{reads++;throw Error('must not call provider');}});
 await assert.rejects(()=>reader('https://www.pku.edu.cn/notices/',{id:'school',name:'本地样例',homepage:'https://www.pku.edu.cn/',announcementUrl:'https://www.pku.edu.cn/notices/'}),(error:any)=>error.code==='LEXMOUNT_NOT_CONFIGURED'&&error.message.includes('LEXMOUNT_PROJECT_ID')&&!error.message.includes(config.apiKey)&&!error.message.includes('bad/project-private-sentinel'));
 assert.equal(reads,0);
});
test('the public health check returns only configuration validity, without accessing sessions or business data',async()=>{
 let calls=0;const handler=withCollectionHealth(async()=>{calls++;return new Response('account required',{status:401});},()=>lexmountConfigurationStatus(config));
 const response=await handler(new Request('https://localhost/.netlify/functions/api?health=collection'));
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{check:'configuration_only',configured:true,issues:[]});assert.equal(calls,0);
 for(const request of [new Request('https://localhost/.netlify/functions/api?health=collection',{method:'POST'}),new Request('https://localhost/.netlify/functions/api'),new Request('https://localhost/other?health=collection')])assert.equal((await handler(request)).status,401);
 assert.equal(calls,3);
});
