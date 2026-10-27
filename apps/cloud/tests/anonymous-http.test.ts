import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAnonymousHttp,createWorkspaceApi,guestCookie,guestIdentity} from '../src/anonymous-http';
import {guestAiRepository} from '../src/guest-ai';
import {assistantProfile} from '../src/assistant-profile';
import {createGateway} from '../src/gateway';
import {fixtureDb,identity} from './feature-fixture';

const ref={id:'a'.repeat(32),owner:'guest_'+'a'.repeat(32)},credential='x'.repeat(43),user={id:'synthetic-account',email:'one@example.test'};
function request(body:unknown,headers:Record<string,string>={}){return new Request('https://campus.example/api',{method:'POST',headers:{origin:'https://campus.example','content-type':'application/json',cookie:`__Host-campus-guest=${credential}`,...headers},body:JSON.stringify(body)});}
test('guest HTTP uses secure opaque cookies, bounded operations and never returns the device credential in JSON',async()=>{
 let created=0,redeemed=0;
 const workspaces={resolve:async(token:unknown)=>token===credential?ref:null,create:async()=>{created++;return{guest:ref,token:credential};},state:async()=>({id:ref.id,transferExpiresAt:null}),generate:async()=>({code:'CR-'+credential,expiresAt:new Date().toISOString()}),cancel:async()=>{},importCode:async()=>{redeemed++;return{};}};
 const handler=createAnonymousHttp({workspaces:workspaces as any,account:async()=>null,address:()=> 'synthetic-ip'});
 const fresh=await handler(request({op:'session'},{cookie:''}));assert.equal(fresh.status,200);assert.equal(created,1);
 const cookie=fresh.headers.get('set-cookie')!;for(const flag of ['__Host-campus-guest=','HttpOnly','Secure','SameSite=Lax','Path=/'])assert.ok(cookie.includes(flag));
 const body=await fresh.text();assert.ok(!body.includes(credential));assert.equal(JSON.parse(body).data.identity.kind,'guest');assert.equal(fresh.headers.get('cache-control'),'no-store');
 const resumed=await handler(request({op:'session'}));assert.equal(resumed.headers.get('set-cookie'),null);assert.equal(created,1);
 assert.equal(guestCookie(request({}, {cookie:'other=fixture; __Host-campus-guest='+credential+'; next=fixture'})),credential);
 assert.equal((await handler(request({op:'transfer.import',code:'fixture',owner:'victim'}))).status,400);assert.equal(redeemed,0);
 assert.equal((await handler(request({op:'transfer.create'},{cookie:''}))).status,401);assert.equal(created,1);
 assert.equal((await handler(request({op:'session'},{origin:'https://evil.test'}))).status,403);
 assert.equal((await handler(request({op:'session',padding:'x'.repeat(2000)}))).status,400);
});
test('default API keeps guest ownership through AI login, requires a real account for AI and an explicit legacy mode',async()=>{
 let account:typeof user|null=null,route='',owner='',throwAccount=false;
 const handler=createWorkspaceApi({account:async()=>{if(throwAccount)throw Error('private upstream secret');return account;},guest:async request=>guestCookie(request)?ref:null,
  legacy:async(_event,user)=>{route='legacy';owner=user.id;return{ok:true,data:{}};},
  public:async(_event,guest,user)=>{route='guest';owner=guest.owner;return{ok:true,data:guestIdentity(guest,user)};},
  ai:async(_event,guest,user)=>{route='ai';owner=user.id;assert.equal(guest.owner,ref.owner);return{ok:true,data:{}};}});
 assert.equal((await handler(request({action:'favorites.list',input:{}}))).status,200);assert.equal(owner,ref.owner);
 assert.equal((await handler(request({action:'ai.status',input:{}}))).status,401);assert.equal(route,'guest');
 account=user;const session=await (await handler(request({action:'session.get',input:{}}))).json() as any;assert.equal(session.data.uid,ref.owner);assert.equal(session.data.account.uid,user.id);
 assert.equal((await handler(request({action:'favorites.set',input:{}}))).status,200);assert.equal(owner,ref.owner);
 assert.equal((await handler(request({action:'ai.status',input:{}}))).status,200);assert.equal(route,'ai');assert.equal(owner,user.id);
 assert.equal((await handler(request({action:'sources.save',input:{}}))).status,401);assert.equal(route,'ai');
 assert.equal((await handler(request({action:'session.get',input:{}},{'x-campus-workspace':'account'}))).status,200);assert.equal(route,'legacy');
 assert.equal((await handler(request({action:'ai.relay',input:{}}))).status,403);
 account=null;assert.equal((await handler(request({action:'session.get',input:{}},{'x-campus-workspace':'account'}))).status,401);
 throwAccount=true;assert.equal((await handler(request({action:'feed.list',input:{}}))).status,200);assert.equal(route,'guest');
 const failed=await handler(request({action:'ai.status',input:{}}));assert.equal(failed.status,503);assert.ok(!(await failed.text()).includes('private upstream'));
});
test('trusted guest gateway rejects private editing, AI and forged claims even when bypassing the HTTP adapter',async()=>{
 const f=fixtureDb(),gateway=createGateway(f.repo,{ownerUid:ref.owner,dataOwnerId:ref.owner,guestWorkspace:true});
 const invoke=(action:string,input:unknown={})=>gateway({action,input},{uid:ref.owner,isAnonymous:true});
 const session=await invoke('session.get');assert.ok(session.ok);assert.equal((session.data as any).capabilities.ai,false);
 for(const action of ['sources.save','ai.status','ai.providers.list','reminders.watch.save']){const result=await invoke(action);assert.ok(!result.ok);assert.equal(result.code,'LOGIN_REQUIRED');}
 const forged=await invoke('feed.list',{schoolId:'bjtu',ownerId:'victim'});assert.ok(!forged.ok);assert.equal(forged.code,'VALIDATION_FAILED');
 const untrusted=await createGateway(f.repo,{ownerUid:ref.owner,dataOwnerId:ref.owner})({action:'session.get',input:{}},{uid:ref.owner,isAnonymous:true});assert.ok(!untrusted.ok);assert.equal(untrusted.code,'UNAUTHENTICATED');
});
test('AI follows the guest reading school while preferences and storage remain owned by the signed-in account',async()=>{
 const f=fixtureDb();f.repo.selectedSchool=async owner=>owner===ref.owner?'bjtu':'other';
 const projected=guestAiRepository(f.repo,identity.dataOwnerId,ref.owner),service=assistantProfile(f.db,projected);
 assert.equal(await f.repo.selectedSchool(identity.dataOwnerId),'other');assert.equal(await projected.selectedSchool(identity.dataOwnerId),'bjtu');
 await service.handle('ai.profile.save',{schoolId:'bjtu',interests:['合成兴趣'],goals:'合成目标',learningEnabled:false,version:0},identity);
 assert.equal(f.rows('user_profiles').has(ref.owner),false);assert.equal(await f.repo.selectedSchool(identity.dataOwnerId),'other');
 assert.ok(JSON.stringify(f.rows('user_profiles').get(identity.dataOwnerId)).includes('合成目标'));
 await assert.rejects(service.handle('ai.profile.get',{schoolId:'other'},identity),{code:'STALE_SCOPE'});
});
