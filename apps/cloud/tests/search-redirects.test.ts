import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolveSearchRedirects} from '../src/search-redirects';
import {publicSearchSource} from '../src/public-search-page';
const url='https://public.example/start',source=()=>publicSearchSource(url),lookup=async()=>[{address:'8.8.8.8'}];
test('redirect metadata remains exact-host/public/robots checked before Fetch, including the final destination',async()=>{
  let calls=0;
  assert.equal(await resolveSearchRedirects(url,source(),{lookup,head:async(target,address)=>{assert.equal(address,'8.8.8.8');calls++;return target.pathname==='/start'?{status:302,location:'/final'}:{status:200};}}),'https://public.example/final');assert.equal(calls,2);
  for(const location of ['https://other.example/end','http://public.example/end','https://public.example:9443/end','https://user:password@public.example/end'])await assert.rejects(resolveSearchRedirects(url,source(),{lookup,head:async()=>({status:302,location})}));
  const restricted=source();restricted.allowedPath=value=>!value.endsWith('/blocked');
  await assert.rejects(resolveSearchRedirects(url,restricted,{lookup,head:async()=>({status:302,location:'/blocked'})}),{code:'SOURCE_ROBOTS_BLOCKED'});
  calls=0;await assert.rejects(resolveSearchRedirects(url,source(),{lookup:async()=>[{address:'10.0.0.1'}],head:async()=>{calls++;return{status:200};}}));assert.equal(calls,0);
});
test('redirect loops, authorization failures and unverified HTTP status cannot be treated as usable body sources',async()=>{
  let calls=0;await assert.rejects(resolveSearchRedirects(url,source(),{lookup,head:async()=>{calls++;return{status:302,location:'/start'};}}));assert.equal(calls,4);
  for(const status of [401,403,404,405,500])await assert.rejects(resolveSearchRedirects(url,source(),{lookup,head:async()=>({status})}));
});
