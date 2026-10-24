import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import https from 'node:https';
import dns from 'node:dns/promises';
import {EventEmitter} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
import {requestChat,replyText,type ChatMessage} from '../src/model-provider';

test('guarded model transport sends tool configuration and continuation without treating tool calls as final text',async()=>{
  const sent:any[]=[];
  mock.method(dns,'lookup',async()=>[{address:'8.8.8.8',family:4}]);
  mock.method(https,'request',(target:URL,options:any,onResponse:(r:any)=>void)=>{
    assert.equal(target.href,'https://api.deepseek.com/chat/completions');assert.equal(options.headers.authorization,'Bearer fixture-only-key');
    const request=new EventEmitter() as any;request.destroy=()=>{};
    request.end=(payload:Buffer)=>{sent.push(JSON.parse(payload.toString()));queueMicrotask(()=>{
      const response=new EventEmitter() as any;response.statusCode=200;onResponse(response);
      response.emit('data',Buffer.from(JSON.stringify({choices:[sent.length===1?{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'fixture-tool',type:'function',function:{name:'web_search',arguments:'{"query":"test"}'}}]}}:{finish_reason:'stop',message:{role:'assistant',content:'完整答案'}}]})));response.emit('end');
    });};return request;
  });syncBuiltinESMExports();
  try{
    const connection={provider:'deepseek' as const,model:'fixture-model',apiKey:'fixture-only-key'};
    const messages:ChatMessage[]=[{role:'system',content:'guide'},{role:'user',content:'question'}],tools=[{type:'function',function:{name:'web_search',parameters:{type:'object'}}}];
    const plan=await requestChat(connection,messages,360,undefined,{tools,toolChoice:'auto'});
    assert.throws(()=>replyText(plan),{code:'MODEL_FORMAT_INVALID'});
    const result=await requestChat(connection,[...messages,plan.message,{role:'tool',tool_call_id:'fixture-tool',content:'actual sources'}],1200,undefined,{tools,toolChoice:'none'});
    assert.equal(replyText(result),'完整答案');assert.deepEqual(sent[0].tools,tools);assert.equal(sent[0].tool_choice,'auto');assert.equal(sent[1].tool_choice,'none');assert.equal(sent[1].messages[3].tool_call_id,'fixture-tool');
    assert.deepEqual(sent[0].thinking,{type:'disabled'});
  }finally{mock.restoreAll();syncBuiltinESMExports();}
});
