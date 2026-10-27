import type {AuthSession,GatewayResult} from '@campus/contracts';
import type {GuestRef,anonymousWorkspaces} from './anonymous-workspace';
import type {NetlifyUser} from './netlify-http';
import {boundedJson,sameOrigin} from './netlify-http';
import {AppError,reject} from './errors';
import {guestActionAllowed} from './guest-access';

export const guestCookieName='__Host-campus-guest';
export function guestCookie(request:Request){const match=request.headers.get('cookie')?.match(/(?:^|;\s*)__Host-campus-guest=([A-Za-z0-9_-]{43})(?:;|$)/);return match?.[1];}
export const guestIdentity=(ref:GuestRef,account:NetlifyUser|null):AuthSession=>({uid:ref.owner,username:'匿名访客',kind:'guest',account:account?{uid:account.id,username:account.email}:null});
const response=(body:unknown,status=200,cookie?:string)=>Response.json(body,{status,headers:{'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff',...(cookie?{'set-cookie':cookie}:{})}});
const failure=(error:unknown)=>error instanceof AppError?response({ok:false,code:error.code,message:error.message},['UNAUTHENTICATED','GUEST_EXPIRED','LOGIN_REQUIRED'].includes(error.code)?401:error.code==='FORBIDDEN'?403:error.code==='VALIDATION_FAILED'?400:error.code==='GUEST_RATE_LIMIT'?429:409):response({ok:false,code:'SERVICE_UNAVAILABLE',message:'工作区暂时不可用，请稍后重试。'},503);

export function createAnonymousHttp(options:{workspaces:ReturnType<typeof anonymousWorkspaces>;account():Promise<NetlifyUser|null>;address(request:Request):string}){
 return async(request:Request):Promise<Response>=>{
  try{
   if(request.method!=='POST')reject('VALIDATION_FAILED','请从个人工作区提交操作。');sameOrigin(request);
   const input=await boundedJson(request,1500),op=input.op;
   if(typeof op!=='string'||!['session','transfer.create','transfer.cancel','transfer.import'].includes(op)||Object.keys(input).some(key=>!['op',...(op==='transfer.import'?['code']:[])].includes(key)))reject('VALIDATION_FAILED','匿名工作区参数无效。');
   let ref=await options.workspaces.resolve(guestCookie(request)),cookie:string|undefined;
   if(!ref){if(op!=='session')reject('GUEST_EXPIRED','本设备匿名身份已失效，请刷新后重新打开工作区。');const created=await options.workspaces.create(options.address(request));ref=created.guest;cookie=`${guestCookieName}=${created.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;}
   if(op==='transfer.create')return response({ok:true,data:await options.workspaces.generate(ref)});
   if(op==='transfer.cancel'){await options.workspaces.cancel(ref);return response({ok:true,data:null});}
   if(op==='transfer.import'){if(typeof input.code!=='string'||input.code.length>100)reject('VALIDATION_FAILED','请输入有效的一次性迁移码。');return response({ok:true,data:await options.workspaces.importCode(ref,input.code)});}
   const account=await options.account().catch(()=>null);
   return response({ok:true,data:{...await options.workspaces.state(ref),identity:guestIdentity(ref,account)}},200,cookie);
  }catch(error){return failure(error);}
 };
}

export function createWorkspaceApi(options:{account():Promise<NetlifyUser|null>;guest(request:Request):Promise<GuestRef|null>;legacy(event:unknown,user:NetlifyUser):Promise<GatewayResult<unknown>>;public(event:unknown,guest:GuestRef,account:NetlifyUser|null):Promise<GatewayResult<unknown>>;ai(event:unknown,guest:GuestRef,user:NetlifyUser):Promise<GatewayResult<unknown>>}){
 return async(request:Request):Promise<Response>=>{
  try{
   if(request.method!=='POST')return response({ok:false,code:'ACTION_NOT_ALLOWED',message:'请使用POST请求。'},405);
   sameOrigin(request);const body=await boundedJson(request),action=typeof body.action==='string'?body.action:'';
   if(action==='ai.relay')reject('FORBIDDEN','本站不提供外部AI中继操作。');
   const account=await options.account().catch(error=>{if(action.startsWith('ai.')||request.headers.get('x-campus-workspace')==='account')throw error;return null;});
   let result:GatewayResult<unknown>;
   if(request.headers.get('x-campus-workspace')==='account'){
    if(!account)reject('LOGIN_REQUIRED','原账号工作区需要登录本人账号。');result=await options.legacy(body,account);
   }else{
    const ref=await options.guest(request);if(!ref)reject('GUEST_EXPIRED','匿名身份已失效，请刷新页面重新进入。');
    if(action.startsWith('ai.')){if(!account)reject('LOGIN_REQUIRED','使用AI需要登录账号，公告、收藏和提醒仍可匿名使用。');result=await options.ai(body,ref,account);}
    else{if(!guestActionAllowed(action))reject('LOGIN_REQUIRED','此操作需要在原账号工作区中登录后使用。');result=await options.public(body,ref,account);}
   }
   return response(result,result.ok?200:result.code==='LOGIN_REQUIRED'||result.code==='UNAUTHENTICATED'?401:result.code==='FORBIDDEN'?403:400);
  }catch(error){return failure(error);}
 };
}
