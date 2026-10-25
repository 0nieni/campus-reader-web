import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSiteAuth,type SiteAuth} from '../src/netlify-http';
test('email registration is bounded, same-origin, secret-free and never adopts an unverified session',async()=>{
  let calls=0,login=0,logout=0,mode='normal';
  const auth:SiteAuth={async user(){return null;},async login(){login++;throw Error('not expected');},async logout(){logout++;},async signup(email,password){calls++;assert.equal(email,'new@example.test');assert.equal(password,'synthetic-password');if(mode==='error')throw Error('raw-provider-body-secret');return {id:'synthetic-user',email,...(mode==='autoconfirm'?{confirmedAt:new Date().toISOString()}:{})};}};
  const handler=createSiteAuth(auth,()=> 'owner@example.test');
  const request=(body:unknown,origin='https://campus.example')=>new Request('https://campus.example/.netlify/functions/auth?op=signup',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
  const valid={email:' NEW@example.test ',password:'synthetic-password'};
  assert.equal((await handler(request(valid,'https://other.example'))).status,403);assert.equal(calls,0);
  for(const value of [{...valid,owner:'forged'}, {...valid,role:'admin'}, {...valid,password:'short'},{...valid,email:'invalid'}, {...valid,password:'a'.repeat(257)}])assert.equal((await handler(request(value))).status,400);
  assert.equal(calls,0);const response=await handler(request(valid));assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,data:{verificationRequired:true}});assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(login,0);assert.equal(logout,0);
  mode='error';const failed=await handler(request(valid));assert.equal(failed.status,503);assert.doesNotMatch(await failed.text(),/raw-provider|synthetic-password|synthetic-user/);
  mode='autoconfirm';const unexpected=await handler(request(valid));assert.equal(unexpected.status,503);assert.equal(logout,1);assert.doesNotMatch(await unexpected.text(),/synthetic-user/);
  assert.equal((await handler(new Request('https://campus.example/auth?op=signup'))).status,405);
});
