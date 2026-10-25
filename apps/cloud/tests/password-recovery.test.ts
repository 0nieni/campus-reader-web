import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSiteAuth,type SiteAuth} from '../src/netlify-http';
test('recovery mail is same-origin, authenticated, bounded, and always targets the server session email',async()=>{
 let user:{id:string;email:string}|null={id:'synthetic-member',email:'member@example.test'},recipient='',calls=0;
 const auth:SiteAuth={async user(){return user;},async login(){throw Error('unexpected');},async logout(){},async requestPasswordRecovery(email){calls++;recipient=email;}};
 const handler=createSiteAuth(auth,()=> 'owner@example.test');
 const request=(body:unknown={},origin='https://campus.example')=>new Request('https://campus.example/auth?op=password-recovery',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await handler(request({},'https://outside.example'))).status,403);
 assert.equal((await handler(request({email:'other@example.test'}))).status,400);
 assert.equal((await handler(request({recipient:'other@example.test'}))).status,400);
 assert.equal((await handler(request({junk:'x'.repeat(1001)}))).status,400);assert.equal(calls,0);
 const result=await handler(request());assert.equal(result.status,200);assert.deepEqual(await result.json(),{ok:true,data:null});assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(recipient,'member@example.test');assert.equal(calls,1);
 user=null;assert.equal((await handler(request())).status,401);assert.equal(calls,1);
 assert.equal((await handler(new Request('https://campus.example/auth?op=password-recovery'))).status,405);
});
test('a mail provider failure never exposes its response or credentials',async()=>{
 const handler=createSiteAuth({async user(){return{id:'member',email:'member@example.test'};},async login(){throw Error('unexpected');},async logout(){},async requestPasswordRecovery(){throw Error('raw-provider-token=secret');}},()=> 'owner@example.test');
 const result=await handler(new Request('https://campus.example/auth?op=password-recovery',{method:'POST',headers:{origin:'https://campus.example','content-type':'application/json'},body:'{}'}));
 assert.equal(result.status,503);const text=await result.text();assert.match(text,/RECOVERY_UNAVAILABLE/);assert.doesNotMatch(text,/raw-provider|secret/);
});
