import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {NetlifyDB} from '@netlify/database-dev';
import {getDatabase} from '@netlify/database';
import type {SqlPool} from '../src/postgres-storage';
import {anonymousWorkspaces} from '../src/anonymous-workspace';
import {mcpAuthorization} from '../src/mcp-auth';
import {createMcpOAuthHttp,createMcpManagementHttp} from '../src/mcp-auth-http';
import {readMcpClientMetadata} from '../src/mcp-client-metadata';
import {auth as clientAuth,Client,StreamableHTTPClientTransport,type OAuthClientProvider,type StoredOAuthClientInformation,type StoredOAuthTokens,type OAuthDiscoveryState} from '@modelcontextprotocol/client';
import {createCampusMcpHttp} from '../src/mcp-http';
import {mcpWorkspaceTools} from '../src/mcp-tools';
import {cleanupMcp} from '../src/mcp-cleanup';
import {mcpHash} from '../src/mcp-security';
const origin='https://campus.example',resource=origin+'/mcp',verifier='v'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
test('MCP OAuth and manual grants use real SQL, bind to the anonymous owner and never persist raw credentials',async t=>{
 const server=new NetlifyDB({logger(){}}),connectionString=await server.start(),native=getDatabase({connectionString}).pool;(native as any).options.max=1;
 const pool=native as unknown as SqlPool;let clock=Date.parse('2026-10-28T04:00:00Z'),reads=0;
 const auth=mcpAuthorization(pool,{origin,now:()=>clock,readMetadata:async url=>{reads++;if(url.includes('fail'))throw Error('private upstream body');return{client_id:url,client_name:'Synthetic metadata client',redirect_uris:['https://client.example/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token']};}});
 try{
  await server.applyMigrations(fileURLToPath(new URL('../../../netlify/database/migrations',import.meta.url)));
  const guests=anonymousWorkspaces(pool,{now:()=>clock}),a=(await guests.create('mcp-synthetic-a')).guest,b=(await guests.create('mcp-synthetic-b')).guest;
  const register=(method='none')=>auth.register({client_name:'Synthetic client',redirect_uris:['https://client.example/callback'],token_endpoint_auth_method:method,grant_types:['authorization_code','refresh_token']},'synthetic-register');
  const app=await register(),other=await register();
  const request=(client=app.client_id,scopes='announcements:read bookmarks:read offline_access')=>({client_id:client,response_type:'code',redirect_uri:'https://client.example/callback',resource,scope:scopes,code_challenge:challenge,code_challenge_method:'S256',state:'synthetic-state'});
  async function issue(scopes='announcements:read bookmarks:read offline_access',client=app.client_id){
   const location=await auth.begin(request(client,scopes),'synthetic-authorize'),ticket=new URL(location).searchParams.get('mcp_authorize')!;
   const info=await auth.info(a,ticket);assert.equal(info.workspaceId,a.id);
   const redirect=await auth.decide(a,{ticket,approved:true,scopes:scopes.split(' ')});assert.equal(new URL(redirect.redirect).searchParams.get('state'),'synthetic-state');
   return{ticket,code:new URL(redirect.redirect).searchParams.get('code')!};
  }
  const exchange=(code:string,changes:Record<string,unknown>={})=>auth.exchange({client_id:app.client_id,grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:'https://client.example/callback',resource,...changes},'none','synthetic-token');
  await t.test('PKCE, resource, redirect and client binding survive rejected attempts; codes consume once',async()=>{
   const {ticket,code}=await issue();
   await assert.rejects(auth.decide(a,{ticket,approved:true,scopes:['announcements:read']}));
   await assert.rejects(exchange(code,{resource:origin+'/other'}),{code:'invalid_target'});
   await assert.rejects(exchange(code,{client_id:other.client_id}),{code:'invalid_grant'});
   await assert.rejects(exchange(code,{code_verifier:'w'.repeat(64)}),{code:'invalid_grant'});
   await assert.rejects(exchange(code,{redirect_uri:'https://evil.example/callback'}),{code:'invalid_grant'});
   const token=await exchange(code);assert.match(token.access_token,/^crm_a_/);assert.ok(token.refresh_token);assert.equal(token.expires_in,3600);
   const principal=await auth.resolve(token.access_token);assert.equal(principal!.owner,a.owner);assert.equal(await auth.resolve(token.refresh_token),null);
   await assert.rejects(auth.assertActive(pool,principal!,'bookmarks:write'),{code:'insufficient_scope'});
   await assert.rejects(exchange(code),{code:'invalid_grant'});
   const stored=JSON.stringify((await pool.query('SELECT * FROM campus_mcp_tokens')).rows)+JSON.stringify((await pool.query('SELECT * FROM campus_mcp_codes')).rows);
   for(const value of [code,token.access_token,token.refresh_token])assert.ok(!stored.includes(value!));
  });
  await t.test('manual credentials are one-time displayed, owner-isolated, scoped and immediately revocable',async()=>{
   const manual=await auth.createManual(a,{name:'Synthetic local app',scopes:['announcements:read','bookmarks:write']}),principal=await auth.resolve(manual.token);
   assert.equal(principal!.workspaceId,a.id);assert.equal((await auth.list(b)).connections.length,0);assert.ok(!JSON.stringify(await auth.list(a)).includes(manual.token));
   await auth.revoke(b,manual.connection.id);assert.ok(await auth.resolve(manual.token));await auth.revoke(a,manual.connection.id);assert.equal(await auth.resolve(manual.token),null);
   await assert.rejects(auth.createManual({...a,owner:b.owner},{name:'forged',scopes:['announcements:read']}),{code:'UNAUTHENTICATED'});
  });
  await t.test('refresh rotation rejects an old token and durably revokes the family without affecting another grant',async()=>{
   const independent=await auth.createManual(a,{name:'Independent',scopes:['announcements:read']}),issued=await issue(),first=await exchange(issued.code);
   clock+=3600001;assert.equal(await auth.resolve(first.access_token),null);
   const refresh=(token:string)=>auth.exchange({client_id:app.client_id,grant_type:'refresh_token',refresh_token:token,resource},'none','synthetic-refresh');
   const second=await refresh(first.refresh_token!);assert.notEqual(first.refresh_token,second.refresh_token);assert.ok(await auth.resolve(second.access_token));
   await assert.rejects(refresh(first.refresh_token!),{code:'invalid_grant'});assert.equal(await auth.resolve(second.access_token),null);assert.ok(await auth.resolve(independent.token));
  });
  await t.test('consent cannot expand scopes; deny/expired requests and codes do not create usable tokens',async()=>{
   const location=await auth.begin(request(app.client_id,'announcements:read'),'synthetic-consent'),ticket=new URL(location).searchParams.get('mcp_authorize')!;
   await assert.rejects(auth.decide(a,{ticket,approved:true,scopes:['bookmarks:write']}),{code:'invalid_scope'});
   const rejected=await auth.decide(a,{ticket,approved:false,scopes:[]});assert.equal(new URL(rejected.redirect).searchParams.get('error'),'access_denied');assert.equal(new URL(rejected.redirect).searchParams.get('code'),null);
   const issued=await issue('announcements:read');clock+=300001;await assert.rejects(exchange(issued.code),{code:'invalid_grant'});
   const next=await auth.begin(request(),'synthetic-consent-expire'),nextTicket=new URL(next).searchParams.get('mcp_authorize')!;clock+=600001;await assert.rejects(auth.info(a,nextTicket),{code:'invalid_request'});
  });
  await t.test('registration validates redirects, confidential clients and safe metadata identities',async()=>{
   const minimal=await auth.register({redirect_uris:['https://minimal.example/callback']},'minimal-registration');assert.equal(minimal.client_name,'minimal.example');assert.equal(minimal.token_endpoint_auth_method,'client_secret_basic');assert.ok(minimal.client_secret);
   for(const uri of ['javascript:alert(1)','http://evil.example/callback','https://user:secret@client.example/callback','https://client.example/#x'])await assert.rejects(auth.register({client_name:'invalid',redirect_uris:[uri]},'synthetic-invalid'));
   const confidential=await register('client_secret_basic'),issued=await issue('announcements:read',confidential.client_id);
   await assert.rejects(auth.exchange({client_id:confidential.client_id,grant_type:'authorization_code',code:issued.code,code_verifier:verifier,redirect_uri:'https://client.example/callback',resource},'none','synthetic-secret'),{code:'invalid_client'});
   const result=await auth.exchange({client_id:confidential.client_id,client_secret:confidential.client_secret,grant_type:'authorization_code',code:issued.code,code_verifier:verifier,redirect_uri:'https://client.example/callback',resource},'client_secret_basic','synthetic-secret');assert.ok(result.access_token);
   assert.ok(!JSON.stringify((await pool.query('SELECT * FROM campus_mcp_clients')).rows).includes(confidential.client_secret!));
   const id='https://client.example/mcp.json';assert.equal((await auth.client(id)).id,id);await auth.client(id);assert.equal(reads,1);
   const failure=await auth.client('https://fail.example/mcp.json').catch(error=>error);assert.equal(failure.code,'invalid_client_metadata');assert.ok(!failure.message.includes('private upstream'));
   for(const url of ['http://localhost/metadata','https://127.0.0.1/metadata','https://user:pass@client.example/meta'])await assert.rejects(readMcpClientMetadata(url));
  });
  await t.test('HTTP discovers standard OAuth metadata and blocks CSRF/owner injection in management',async()=>{
   const oauth=createMcpOAuthHttp({auth,address:()=> 'synthetic-http'}),management=createMcpManagementHttp({auth,guest:async()=>a});
   const metadata=await oauth(new Request(origin+'/.well-known/oauth-authorization-server'));assert.equal(metadata.status,200);assert.equal((await metadata.json() as any).issuer,origin);assert.equal(metadata.headers.get('cache-control'),'no-store');
   const resourceInfo=await oauth(new Request(origin+'/.well-known/oauth-protected-resource/mcp'));assert.equal((await resourceInfo.json() as any).resource,resource);
   const req=(body:unknown,source=origin)=>new Request(origin+'/manage',{method:'POST',headers:{origin:source,'content-type':'application/json'},body:JSON.stringify(body)});
   assert.equal((await management(req({op:'list'},'https://evil.example'))).status,403);assert.equal((await management(req({op:'create',name:'injected',scopes:['announcements:read'],owner:b.owner}))).status,400);
   const list=await management(req({op:'list'}));assert.equal((await list.json() as any).data.workspaceId,a.id);
   const duplicate=await oauth(new Request(origin+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'client_id=a&client_id=b'}));assert.equal(duplicate.status,400);
  });
  await t.test('official OAuth client discovers, registers, authorizes, refreshes and connects with loopback callback ports',async()=>{
   const oauth=createMcpOAuthHttp({auth,address:()=> 'official-oauth-test'}),mcp=createCampusMcpHttp({pool,auth,tools:mcpWorkspaceTools(pool,{auth,now:()=>clock}),address:()=> 'official-oauth-test',now:()=>clock});
   const fetchFn:typeof fetch=async(input,init)=>{const req=new Request(input,init);return new URL(req.url).pathname==='/mcp'?mcp(req):oauth(req);};
   let information:StoredOAuthClientInformation|undefined,tokens:StoredOAuthTokens|undefined,authorization:URL|undefined,pkce='',discovery:OAuthDiscoveryState|undefined;
   const provider:OAuthClientProvider={redirectUrl:'http://127.0.0.1:7292/callback',clientMetadata:{client_name:'Official SDK synthetic client',redirect_uris:['http://127.0.0.1:7292/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']},state:()=> 'official-client-state',clientInformation:()=>information,saveClientInformation:value=>{information=value;},tokens:()=>tokens,saveTokens:value=>{tokens=value;},redirectToAuthorization:value=>{authorization=value;},saveCodeVerifier:value=>{pkce=value;},codeVerifier:()=>pkce,discoveryState:()=>discovery,saveDiscoveryState:value=>{discovery=value;}};
   assert.equal(await clientAuth(provider,{serverUrl:resource,scope:'announcements:read offline_access',fetchFn}),'REDIRECT');assert.ok(information);assert.ok(authorization);assert.ok(pkce);
   const response=await oauth(new Request(authorization));assert.equal(response.status,303);const ticket=new URL(response.headers.get('location')!).searchParams.get('mcp_authorize')!;
   const consent=await auth.info(a,ticket);assert.deepEqual(consent.scopes,['announcements:read','offline_access']);
   const callback=new URL((await auth.decide(a,{ticket,approved:true,scopes:consent.scopes})).redirect);assert.equal(callback.searchParams.get('state'),'official-client-state');
   assert.equal(await clientAuth(provider,{serverUrl:resource,authorizationCode:callback.searchParams.get('code')!,iss:callback.searchParams.get('iss')!,fetchFn}),'AUTHORIZED');assert.ok(tokens?.access_token);assert.ok(tokens?.refresh_token);
   const client=new Client({name:'official-oauth',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
   try{await client.connect(new StreamableHTTPClientTransport(new URL(resource),{authProvider:provider,fetch:fetchFn}));assert.equal((await client.listTools()).tools.length,10);const result=await client.callTool({name:'campus_list_schools',arguments:{limit:1}});assert.ok(!result.isError);}finally{await client.close();}
   const prior=tokens!.refresh_token;assert.equal(await clientAuth(provider,{serverUrl:resource,fetchFn}),'AUTHORIZED');assert.notEqual(tokens!.refresh_token,prior);
   const app=await auth.register({client_name:'Loopback ephemeral port',redirect_uris:['http://127.0.0.1/callback']},'loopback-test');
   assert.ok(await auth.begin({...request(app.client_id,'announcements:read'),redirect_uri:'http://127.0.0.1:34567/callback'},'loopback-test'));
   await assert.rejects(auth.begin({...request(app.client_id,'announcements:read'),redirect_uri:'http://localhost:34567/callback'},'loopback-test'),{code:'invalid_redirect_uri'});
   const cross=new Request(resource,{method:'POST',headers:{origin:'https://new-client.example','content-type':'application/json'},body:'{}'});const first=await mcp(cross);assert.equal(first.status,401);assert.equal(first.headers.get('access-control-allow-origin'),'https://new-client.example');
   const probe=await mcp(new Request(resource,{method:'OPTIONS',headers:{origin:'https://new-client.example'}}));assert.equal(probe.status,204);
   const error=await oauth(new Request(origin+'/oauth/token',{method:'POST',headers:{origin:'https://new-client.example','content-type':'application/x-www-form-urlencoded'},body:'grant_type=invalid'}));assert.equal(error.headers.get('access-control-allow-origin'),'*');
  });
  await t.test('cleanup expires records in bounded batches and preserves active refresh replay proofs',async()=>{
   const {code}=await issue(),first=await exchange(code),refresh=(value:string)=>auth.exchange({client_id:app.client_id,grant_type:'refresh_token',refresh_token:value,resource},'none','cleanup-refresh');
   const second=await refresh(first.refresh_token!);clock+=3600001;
   await pool.query("INSERT INTO campus_mcp_limits(bucket,subject,used,expires_at) SELECT 'expired-'||s,'synthetic',1,$1 FROM generate_series(1,1005) AS s",['2000-01-01T00:00:00Z']);
   await cleanupMcp(pool,clock);assert.equal((await pool.query("SELECT count(*) AS count FROM campus_mcp_limits WHERE bucket LIKE 'expired-%'")).rows[0].count,'5');
   assert.ok((await pool.query('SELECT consumed_at FROM campus_mcp_tokens WHERE token_hash=$1',[mcpHash(first.refresh_token!)])).rows[0].consumed_at);await assert.rejects(refresh(first.refresh_token!),{code:'invalid_grant'});assert.equal(await auth.resolve(second.access_token),null);
  });
 }finally{await native.end();await server.stop();}
});
