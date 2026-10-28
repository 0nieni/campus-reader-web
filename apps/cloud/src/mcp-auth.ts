import {createHash} from 'node:crypto';
import type {McpConnection,McpScope,McpConsent} from '@campus/contracts';
import {mcpScopes} from '../../../packages/contracts/src/index';
import type {SqlPool,SqlClient,SqlExecutor,Row} from './postgres-storage';
import type {GuestRef} from './anonymous-workspace';
import {readMcpClientMetadata} from './mcp-client-metadata';
import {checkedMcpScopes,mcpEqual,mcpFail,mcpHash,mcpId,mcpIso,mcpLimit,mcpRandom,mcpRedirect,mcpRedirectMatches,mcpTransaction} from './mcp-security';
export interface McpPrincipal {grantId:string;workspaceId:string;owner:string;scopes:McpScope[];expiresAt:string;tokenHash:string;resource:string}
interface Options {origin:string;now?:()=>number;readMetadata?:(url:string)=>Promise<unknown>}
const day=86400000;
const plain=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
const stamp=(value:unknown)=>new Date(value as string).toISOString();
export function mcpAuthorization(pool:SqlPool,options:Options){
 const now=options.now||Date.now,origin=new URL(options.origin).origin,resource=origin+'/mcp',readMetadata=options.readMetadata||readMcpClientMetadata;
 function clientBody(input:unknown,cimd?:string){
  const body=plain(input),redirects=body.redirect_uris;
  if(!Array.isArray(redirects)||!redirects.length||redirects.length>10)mcpFail('invalid_client_metadata','客户端需提供1至10个有效回调地址。');
  const redirectUris=[...new Set(redirects.map(mcpRedirect))],name=body.client_name===undefined?new URL(cimd||redirectUris[0]!).hostname:body.client_name;
  if(typeof name!=='string'||!name.trim()||name.length>100||/[\x00-\x1f\x7f]/.test(name))mcpFail('invalid_client_metadata','客户端名称无效。');
  if(cimd&&body.client_id!==cimd)mcpFail('invalid_client_metadata','客户端元数据标识不匹配。');
  const method=body.token_endpoint_auth_method||(cimd?'none':'client_secret_basic');if(!['none','client_secret_post','client_secret_basic'].includes(method)||cimd&&method!=='none')mcpFail('invalid_client_metadata','客户端认证方式不受支持。');
  const grants=body.grant_types===undefined?['authorization_code']:body.grant_types;
  if(!Array.isArray(grants)||!grants.includes('authorization_code')||grants.some(value=>!['authorization_code','refresh_token'].includes(value))||grants.length>2||body.response_types!==undefined&&(!Array.isArray(body.response_types)||body.response_types.length!==1||body.response_types[0]!=='code'))mcpFail('invalid_client_metadata','仅支持授权码及刷新令牌。');
  return{client_name:name.trim(),redirect_uris:redirectUris,token_endpoint_auth_method:method,grant_types:grants,response_types:['code'],...(cimd?{client_id:cimd,cimd:true}:{}),...(body.scope!==undefined?{scope:checkedMcpScopes(body.scope).join(' ')}:{})};
 }
 async function register(input:unknown,address:string){
  await mcpLimit(pool,'register-global','all',500,now(),day);await mcpLimit(pool,'register-address',address,20,now(),3600000);
  const body=clientBody(input),id='crclient_'+mcpId(),secret=body.token_endpoint_auth_method==='none'?null:mcpRandom(),expires=now()+365*day;
  await pool.query('INSERT INTO campus_mcp_clients(id,body,secret_hash,created_at,expires_at) VALUES($1,$2::jsonb,$3,$4,$5)',[id,JSON.stringify(body),secret?mcpHash(secret):null,mcpIso(now()),mcpIso(expires)]);
  return{...body,client_id:id,client_id_issued_at:Math.floor(now()/1000),...(secret?{client_secret:secret,client_secret_expires_at:Math.floor(expires/1000)}:{})};
 }
 async function client(id:unknown,address='unknown'):Promise<Row>{
  if(typeof id!=='string'||!id||id.length>1800)mcpFail('invalid_client','客户端标识无效。');
  const prior=(await pool.query('SELECT * FROM campus_mcp_clients WHERE id=$1',[id])).rows[0];
  if(prior&&Date.parse(prior.expires_at)>now())return prior;
  if(!(id as string).startsWith('https://'))mcpFail('invalid_client','客户端未注册或已过期。');
  await mcpLimit(pool,'metadata-address',address,20,now(),3600000);
  let metadata:unknown;try{metadata=await readMetadata(id as string);}catch{return mcpFail('invalid_client_metadata','无法读取公开客户端元数据，请检查HTTPS地址及网络。');}
  const body=clientBody(metadata,id as string);
  const result=await pool.query("INSERT INTO campus_mcp_clients(id,body,created_at,expires_at) VALUES($1,$2::jsonb,$3,$4) ON CONFLICT(id) DO UPDATE SET body=EXCLUDED.body,expires_at=EXCLUDED.expires_at WHERE campus_mcp_clients.body->>'cimd'='true' RETURNING *",[id,JSON.stringify(body),mcpIso(now()),mcpIso(now()+day)]);
  if(!result.rows.length)mcpFail('invalid_client','客户端元数据类型不匹配。');return result.rows[0];
 }
 async function begin(input:Record<string,unknown>,address:string){
  await mcpLimit(pool,'authorize-address',address,60,now(),3600000);
  if(input.response_type!=='code'||input.resource!==resource||input.code_challenge_method!=='S256'||typeof input.code_challenge!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.code_challenge)||input.state!==undefined&&(typeof input.state!=='string'||input.state.length>1024))mcpFail('invalid_request','需要授权码模式、正确资源地址及S256 PKCE参数。');
  const app=await client(input.client_id,address),redirect=mcpRedirect(input.redirect_uri);
  if(!app.body.redirect_uris.some((registered:string)=>mcpRedirectMatches(registered,redirect)))mcpFail('invalid_redirect_uri','回调地址未在该客户端登记。');
  const scopes=checkedMcpScopes(input.scope,true),ticket=mcpRandom(),expiresAt=mcpIso(now()+600000);
  await pool.query('INSERT INTO campus_mcp_pending(ticket_hash,client_id,redirect_uri,resource,scopes,challenge,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[mcpHash(ticket),app.id,redirect,resource,scopes,input.code_challenge,input.state||'',expiresAt]);
  return origin+'/?mcp_authorize='+encodeURIComponent(ticket);
 }
 const checkGuest=(ref:GuestRef)=>{if(!/^[a-f0-9]{32}$/.test(ref.id)||ref.owner!=='guest_'+ref.id)mcpFail('UNAUTHENTICATED','匿名工作区身份无效。');};
 async function lockGuest(sql:SqlClient,ref:GuestRef){checkGuest(ref);if(!(await sql.query('SELECT id FROM campus_guest_workspaces WHERE id=$1 FOR UPDATE',[ref.id])).rows.length)mcpFail('UNAUTHENTICATED','匿名工作区已失效。');}
 async function pending(sql:SqlExecutor,ticket:string,lock=false){
  if(!/^[A-Za-z0-9_-]{43}$/.test(ticket))mcpFail('invalid_request','授权请求无效，请从AI客户端重新连接。');
  const row=(await sql.query(`SELECT * FROM campus_mcp_pending WHERE ticket_hash=$1${lock?' FOR UPDATE':''}`,[mcpHash(ticket)])).rows[0];
  if(!row||row.consumed_at||row.resource!==resource||Date.parse(row.expires_at)<=now())mcpFail('invalid_request','授权请求已过期或已处理，请重新连接。');return row;
 }
 async function info(ref:GuestRef,ticket:string):Promise<McpConsent>{
  checkGuest(ref);const row=await pending(pool,ticket),app=await client(row.client_id);
  return{ticket,clientName:app.body.client_name,clientOrigin:app.body.cimd?new URL(app.id).origin:new URL(row.redirect_uri).origin,redirectOrigin:new URL(row.redirect_uri).origin,workspaceId:ref.id,scopes:row.scopes,expiresAt:stamp(row.expires_at)};
 }
 function connection(row:Row):McpConnection{return{id:row.id,name:row.name,kind:row.client_id?'oauth':'manual',clientOrigin:row.allowed_origins[0]||null,scopes:row.scopes,createdAt:stamp(row.created_at),expiresAt:stamp(row.expires_at),lastUsedAt:row.last_used_at?stamp(row.last_used_at):null};}
 async function newGrant(sql:SqlClient,ref:GuestRef,name:string,scopes:McpScope[],app?:Row,redirect?:string){
  const count=Number((await sql.query('SELECT count(*) AS count FROM campus_mcp_grants WHERE workspace_id=$1 AND revoked_at IS NULL AND expires_at>$2',[ref.id,mcpIso(now())])).rows[0].count);
  if(count>=20)mcpFail('CONNECTION_LIMIT','当前工作区最多保留20个有效MCP连接，请先撤销旧连接。');
  const origins=app?[...new Set([...(app.body.redirect_uris as string[]),...(redirect?[redirect]:[])].map(value=>new URL(value).origin))]:[];
  const row=(await sql.query('INSERT INTO campus_mcp_grants(id,workspace_id,client_id,name,resource,scopes,allowed_origins,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[mcpId(),ref.id,app?.id||null,name,resource,scopes,origins,mcpIso(now()),mcpIso(now()+90*day)])).rows[0];return row;
 }
 async function decide(ref:GuestRef,input:{ticket:string;approved:boolean;scopes:unknown}){
  return mcpTransaction(pool,async sql=>{
   await lockGuest(sql,ref);const row=await pending(sql,input.ticket,true),app=(await sql.query('SELECT * FROM campus_mcp_clients WHERE id=$1',[row.client_id])).rows[0];
   const redirect=new URL(row.redirect_uri);redirect.searchParams.set('state',row.state);redirect.searchParams.set('iss',origin);
   if(!input.approved)redirect.searchParams.set('error','access_denied');
   else{
    if(!app||Date.parse(app.expires_at)<=now())mcpFail('invalid_client','客户端已过期，请重新连接。');
    const scopes=checkedMcpScopes(input.scopes);if(scopes.some(scope=>!row.scopes.includes(scope)))mcpFail('invalid_scope','不能授予客户端未请求的权限。');
    const grant=await newGrant(sql,ref,app.body.client_name,scopes,app,row.redirect_uri),code=mcpRandom();
    await sql.query('INSERT INTO campus_mcp_codes(code_hash,grant_id,redirect_uri,challenge,expires_at) VALUES($1,$2,$3,$4,$5)',[mcpHash(code),grant.id,row.redirect_uri,row.challenge,mcpIso(now()+300000)]);redirect.searchParams.set('code',code);
   }
   await sql.query('UPDATE campus_mcp_pending SET consumed_at=$2 WHERE ticket_hash=$1',[row.ticket_hash,mcpIso(now())]);return{redirect:redirect.href};
  });
 }
 async function createManual(ref:GuestRef,input:{name:unknown;scopes:unknown}){
  checkGuest(ref);if(typeof input.name!=='string'||!input.name.trim()||input.name.length>80||/[\x00-\x1f\x7f]/.test(input.name))mcpFail('VALIDATION_FAILED','请填写80字以内的连接名称。');
  const scopes=checkedMcpScopes(input.scopes).filter(scope=>scope!=='offline_access');if(!scopes.length)mcpFail('invalid_scope','请选择至少一项资料权限。');
  await mcpLimit(pool,'manual-create',ref.id,20,now(),day);
  return mcpTransaction(pool,async sql=>{await lockGuest(sql,ref);const grant=await newGrant(sql,ref,input.name as string,scopes),token='crm_k_'+mcpRandom();await sql.query("INSERT INTO campus_mcp_tokens(token_hash,grant_id,kind,expires_at) VALUES($1,$2,'manual',$3)",[mcpHash(token),grant.id,grant.expires_at]);return{connection:connection(grant),token};});
 }
 async function list(ref:GuestRef){checkGuest(ref);const rows=(await pool.query('SELECT * FROM campus_mcp_grants WHERE workspace_id=$1 AND resource=$2 AND revoked_at IS NULL AND expires_at>$3 ORDER BY created_at DESC LIMIT 20',[ref.id,resource,mcpIso(now())])).rows;return{url:resource,workspaceId:ref.id,connections:rows.map(connection)};}
 async function revoke(ref:GuestRef,id:string){checkGuest(ref);if(!/^[a-f0-9]{32}$/.test(id))mcpFail('VALIDATION_FAILED','连接编号无效。');await mcpTransaction(pool,async sql=>{await lockGuest(sql,ref);await sql.query('UPDATE campus_mcp_grants SET revoked_at=$3 WHERE id=$1 AND workspace_id=$2 AND resource=$4',[id,ref.id,mcpIso(now()),resource]);});}
 async function authenticateClient(id:unknown,secret:unknown,method:string,address:string){
  const app=await client(id,address),expected=app.body.token_endpoint_auth_method;
  if(expected!==method||expected!=='none'&&(typeof secret!=='string'||!app.secret_hash||!mcpEqual(app.secret_hash,mcpHash(secret)))||expected==='none'&&secret!==undefined)mcpFail('invalid_client','客户端认证未通过。');return app;
 }
 async function tokens(sql:SqlClient,grant:Row,app:Row){
  const access='crm_a_'+mcpRandom(),until=Math.min(now()+3600000,Date.parse(grant.expires_at));
  await sql.query("INSERT INTO campus_mcp_tokens(token_hash,grant_id,kind,expires_at) VALUES($1,$2,'access',$3)",[mcpHash(access),grant.id,mcpIso(until)]);
  let refresh:string|undefined;if(grant.scopes.includes('offline_access')&&app.body.grant_types.includes('refresh_token')){refresh='crm_r_'+mcpRandom();await sql.query("INSERT INTO campus_mcp_tokens(token_hash,grant_id,kind,expires_at) VALUES($1,$2,'refresh',$3)",[mcpHash(refresh),grant.id,grant.expires_at]);}
  return{access_token:access,token_type:'Bearer',expires_in:Math.floor((until-now())/1000),scope:grant.scopes.join(' '),...(refresh?{refresh_token:refresh}:{})};
 }
 async function exchange(input:Record<string,unknown>,method:string,address:string){
  await mcpLimit(pool,'token-address',address,120,now());
  if(input.resource!==resource)mcpFail('invalid_target','令牌资源地址不匹配。');
  const app=await authenticateClient(input.client_id,input.client_secret,method,address);
  if(input.grant_type==='authorization_code'){
   if(typeof input.code!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.code)||typeof input.code_verifier!=='string'||!/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier))mcpFail('invalid_grant','授权码或PKCE验证无效。');
   return mcpTransaction(pool,async sql=>{
    const row=(await sql.query('SELECT * FROM campus_mcp_codes WHERE code_hash=$1 FOR UPDATE',[mcpHash(input.code as string)])).rows[0];
    if(!row||row.consumed_at||Date.parse(row.expires_at)<=now()||row.redirect_uri!==input.redirect_uri||!mcpEqual(row.challenge,createHash('sha256').update(input.code_verifier as string).digest('base64url')))mcpFail('invalid_grant','授权码无效、已过期、已使用或PKCE验证未通过。');
    const grant=(await sql.query('SELECT * FROM campus_mcp_grants WHERE id=$1 FOR UPDATE',[row.grant_id])).rows[0];
    if(!grant||grant.client_id!==app.id||grant.resource!==resource||grant.revoked_at||Date.parse(grant.expires_at)<=now()||!app.body.redirect_uris.some((registered:string)=>mcpRedirectMatches(registered,row.redirect_uri)))mcpFail('invalid_grant','授权已失效或不属于该客户端。');
    await sql.query('UPDATE campus_mcp_codes SET consumed_at=$2 WHERE code_hash=$1',[row.code_hash,mcpIso(now())]);return tokens(sql,grant,app);
   });
  }
  if(input.grant_type!=='refresh_token'||!app.body.grant_types.includes('refresh_token')||typeof input.refresh_token!=='string'||!/^crm_r_[A-Za-z0-9_-]{43}$/.test(input.refresh_token))mcpFail('unsupported_grant_type','不支持的令牌请求。');
  const result=await mcpTransaction(pool,async sql=>{
   const row=(await sql.query('SELECT * FROM campus_mcp_tokens WHERE token_hash=$1 AND kind=\'refresh\' FOR UPDATE',[mcpHash(input.refresh_token as string)])).rows[0];
   if(!row||Date.parse(row.expires_at)<=now())mcpFail('invalid_grant','刷新令牌已失效，请重新授权。');
   const grant=(await sql.query('SELECT * FROM campus_mcp_grants WHERE id=$1 FOR UPDATE',[row.grant_id])).rows[0];
   if(!grant||grant.client_id!==app.id||grant.resource!==resource||grant.revoked_at||Date.parse(grant.expires_at)<=now())mcpFail('invalid_grant','连接已撤销或不属于该客户端。');
   if(row.consumed_at){await sql.query('UPDATE campus_mcp_grants SET revoked_at=$2 WHERE id=$1',[grant.id,mcpIso(now())]);return null;}
   await sql.query('UPDATE campus_mcp_tokens SET consumed_at=$2 WHERE token_hash=$1',[row.token_hash,mcpIso(now())]);return tokens(sql,grant,app);
  });if(!result)mcpFail('invalid_grant','检测到刷新令牌重复使用，连接已撤销，请重新授权。');return result;
 }
 async function resolve(token:string|undefined):Promise<McpPrincipal|null>{
  if(!token||!/^crm_[ak]_[A-Za-z0-9_-]{43}$/.test(token))return null;
  const row=(await pool.query("SELECT g.*,t.expires_at AS token_expires,t.token_hash FROM campus_mcp_tokens t JOIN campus_mcp_grants g ON g.id=t.grant_id WHERE t.token_hash=$1 AND t.kind IN ('access','manual') AND t.consumed_at IS NULL AND t.expires_at>$2 AND g.expires_at>$2 AND g.revoked_at IS NULL AND g.resource=$3",[mcpHash(token),mcpIso(now()),resource])).rows[0];if(!row)return null;
  await pool.query('UPDATE campus_mcp_grants SET last_used_at=$2 WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<$3)',[row.id,mcpIso(now()),mcpIso(now()-60000)]);
  return{grantId:row.id,workspaceId:row.workspace_id,owner:'guest_'+row.workspace_id,scopes:row.scopes,expiresAt:stamp(row.token_expires),tokenHash:row.token_hash,resource};
 }
 async function assertActive(sql:SqlExecutor,principal:McpPrincipal,scope:McpScope,lock=false){
  if(principal.owner!=='guest_'+principal.workspaceId)mcpFail('UNAUTHENTICATED','MCP工作区身份不匹配。');
  const row=(await sql.query(`SELECT g.* FROM campus_mcp_grants g JOIN campus_mcp_tokens t ON t.grant_id=g.id WHERE g.id=$1 AND g.workspace_id=$2 AND g.resource=$3 AND t.token_hash=$4 AND t.kind IN ('manual','access') AND t.expires_at>$5 AND g.expires_at>$5 AND g.revoked_at IS NULL${lock?' FOR UPDATE OF g':''}`,[principal.grantId,principal.workspaceId,resource,principal.tokenHash,mcpIso(now())])).rows[0];
  if(!row)mcpFail('UNAUTHENTICATED','MCP连接已撤销或过期，请重新授权。');if(!(row.scopes as string[]).includes(scope))mcpFail('insufficient_scope','此MCP连接缺少权限：'+scope+'。请在网站重新授权。');return row;
 }
 async function originAllowed(value:string,grantId:string){if(value===origin)return true;return Boolean((await pool.query('SELECT id FROM campus_mcp_grants WHERE id=$4 AND $1=ANY(allowed_origins) AND resource=$2 AND revoked_at IS NULL AND expires_at>$3 LIMIT 1',[value,resource,mcpIso(now()),grantId])).rows.length);}
 async function revokeToken(input:Record<string,unknown>,method:string,address:string){
  await mcpLimit(pool,'revoke-address',address,60,now());const app=await authenticateClient(input.client_id,input.client_secret,method,address);
  if(typeof input.token!=='string'||input.token.length>100)mcpFail('invalid_request','撤销令牌参数无效。');
  await pool.query('UPDATE campus_mcp_grants SET revoked_at=$3 WHERE client_id=$1 AND id IN (SELECT grant_id FROM campus_mcp_tokens WHERE token_hash=$2)',[app.id,mcpHash(input.token as string),mcpIso(now())]);
 }
 const metadata=()=>({issuer:origin,authorization_endpoint:origin+'/oauth/authorize',token_endpoint:origin+'/oauth/token',registration_endpoint:origin+'/oauth/register',revocation_endpoint:origin+'/oauth/revoke',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none','client_secret_post','client_secret_basic'],revocation_endpoint_auth_methods_supported:['none','client_secret_post','client_secret_basic'],code_challenge_methods_supported:['S256'],scopes_supported:[...mcpScopes],client_id_metadata_document_supported:true,authorization_response_iss_parameter_supported:true});
 return{resource,origin,register,client,begin,info,decide,createManual,list,revoke,exchange,resolve,assertActive,originAllowed,revokeToken,metadata};
}
