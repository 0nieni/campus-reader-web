import {AppError} from './errors';
import {boundedJson,sameOrigin} from './netlify-http';
import type {mcpAuthorization} from './mcp-auth';
import type {GuestRef} from './anonymous-workspace';
type Authorization=ReturnType<typeof mcpAuthorization>;
const privateHeaders={'cache-control':'no-store','pragma':'no-cache','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
const json=(body:unknown,status=200,extra:Record<string,string>={})=>Response.json(body,{status,headers:{...privateHeaders,...extra}});
const error=(caught:unknown)=>{
 const known=caught instanceof AppError,code=known?caught.code:'server_error';
 return json({error:code,error_description:known?caught.message:'MCP授权服务暂时不可用，请稍后重试。'},code==='invalid_client'?401:code==='rate_limited'?429:code==='server_error'?503:400);
};
async function form(request:Request){
 const content=request.headers.get('content-type')||'';
 if(!content.toLowerCase().startsWith('application/x-www-form-urlencoded'))throw new AppError('invalid_request','令牌请求需使用表单编码。');
 // Reuse the bounded streaming reader; never materialize an unbounded body.
 const reader=request.body?.getReader();let text='',bytes=0;const decoder=new TextDecoder();
 if(!reader)throw new AppError('invalid_request','请求参数为空。');
 for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>12000){await reader.cancel();throw new AppError('invalid_request','请求过长。');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();
 const params=new URLSearchParams(text),input:Record<string,string>={};
 for(const [key,value] of params){if(Object.prototype.hasOwnProperty.call(input,key))throw new AppError('invalid_request','请求含重复参数。');input[key]=value;}
 return input;
}
function credentials(request:Request,input:Record<string,unknown>){
 const header=request.headers.get('authorization');
 if(header){
  if(!header.startsWith('Basic ')||header.length>6000)throw new AppError('invalid_client','客户端认证方式无效。');
  let decoded:string;try{decoded=Buffer.from(header.slice(6),'base64').toString('utf8');}catch{throw new AppError('invalid_client','客户端认证无效。');}
  const at=decoded.indexOf(':');if(at<1||input.client_secret!==undefined)throw new AppError('invalid_client','客户端认证参数冲突。');
  let id:string,secret:string;try{id=decodeURIComponent(decoded.slice(0,at));secret=decodeURIComponent(decoded.slice(at+1));}catch{throw new AppError('invalid_client','客户端认证编码无效。');}
  if(input.client_id!==undefined&&input.client_id!==id)throw new AppError('invalid_client','客户端标识冲突。');
  input.client_id=id;input.client_secret=secret;return'client_secret_basic';
 }
 return input.client_secret===undefined?'none':'client_secret_post';
}
export function createMcpOAuthHttp(options:{auth:Authorization;address(request:Request):string}){
 const {auth}=options;
 return async(request:Request)=>{
  try{
   const url=new URL(request.url),path=url.pathname;
   if(url.origin!==auth.origin)return json({error:'invalid_request',error_description:'授权服务地址不匹配。'},400);
   const metadata=path==='/.well-known/oauth-authorization-server'||path.endsWith('/authorization-metadata');
   const resource=path.startsWith('/.well-known/oauth-protected-resource')||path.endsWith('/resource-metadata');
   const cors={'access-control-allow-origin':'*','access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'Content-Type, Authorization','access-control-max-age':'600'};
   if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...privateHeaders,...cors}});
   if(request.method==='GET'&&(metadata||resource))return json(metadata?auth.metadata():{resource:auth.resource,authorization_servers:[auth.origin],scopes_supported:auth.metadata().scopes_supported,bearer_methods_supported:['header'],resource_name:'校园阅览室 MCP'},200,cors);
   if(path.endsWith('/authorize')&&request.method==='GET'){
    if([...url.searchParams.keys()].some(key=>url.searchParams.getAll(key).length!==1)||url.href.length>12000)throw new AppError('invalid_request','授权请求参数重复或过长。');
    return new Response(null,{status:303,headers:{...privateHeaders,location:await auth.begin(Object.fromEntries(url.searchParams),options.address(request))}});
   }
   if(request.method!=='POST')return json({error:'invalid_request',error_description:'请求方法不受支持。'},405,{allow:'GET, POST'});
   // These public OAuth endpoints do not consume cookies. PKCE/client proofs
   // protect exchanges; CORS permits standards-based browser clients too.
   if(path.endsWith('/register'))return json(await auth.register(await boundedJson(request,12000),options.address(request)),201,cors);
   if(path.endsWith('/token')||path.endsWith('/revoke')){
    const input=await form(request),method=credentials(request,input);
    if(path.endsWith('/revoke')){await auth.revokeToken(input,method,options.address(request));return new Response(null,{status:200,headers:{...privateHeaders,...cors}});}
    return json(await auth.exchange(input,method,options.address(request)),200,cors);
   }
   return json({error:'invalid_request',error_description:'授权接口不存在。'},404);
  }catch(caught){const response=error(caught);response.headers.set('access-control-allow-origin','*');return response;}
 };
}
export function createMcpManagementHttp(options:{auth:Authorization;guest(request:Request):Promise<GuestRef|null>}){
 return async(request:Request)=>{
  try{
   if(request.method!=='POST')return json({ok:false,code:'ACTION_NOT_ALLOWED',message:'请从个人工作区提交操作。'},405);
   sameOrigin(request);const ref=await options.guest(request);if(!ref)throw new AppError('UNAUTHENTICATED','请刷新页面后进入当前匿名工作区。');
   const body=await boundedJson(request,4000),keys:Record<string,string[]>={list:[],create:['name','scopes'],revoke:['id'],'consent.info':['ticket'],'consent.decide':['ticket','approved','scopes']};
   if(typeof body.op!=='string'||!Object.prototype.hasOwnProperty.call(keys,body.op)||Object.keys(body).some(key=>key!=='op'&&!keys[body.op as string].includes(key)))throw new AppError('VALIDATION_FAILED','MCP管理参数无效。');
   let data:unknown;
   if(body.op==='list')data=await options.auth.list(ref);
   else if(body.op==='create')data=await options.auth.createManual(ref,{name:body.name,scopes:body.scopes});
   else if(body.op==='revoke'){if(typeof body.id!=='string')throw new AppError('VALIDATION_FAILED','连接编号无效。');await options.auth.revoke(ref,body.id);data=null;}
   else{
    if(typeof body.ticket!=='string')throw new AppError('VALIDATION_FAILED','授权请求编号无效。');
    if(body.op==='consent.info')data=await options.auth.info(ref,body.ticket);
    else{if(typeof body.approved!=='boolean')throw new AppError('VALIDATION_FAILED','请选择允许或拒绝。');data=await options.auth.decide(ref,{ticket:body.ticket,approved:body.approved,scopes:body.scopes});}
   }
   return json({ok:true,data});
  }catch(caught){return json({ok:false,code:caught instanceof AppError?caught.code:'SERVICE_UNAVAILABLE',message:caught instanceof AppError?caught.message:'MCP连接服务暂时不可用，请稍后重试。'},caught instanceof AppError&&caught.code==='UNAUTHENTICATED'?401:caught instanceof AppError&&caught.code==='FORBIDDEN'?403:400);}
 };
}
