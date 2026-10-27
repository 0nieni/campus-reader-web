import {getUser} from '@netlify/identity';
import {getDatabase} from '@netlify/database';
import {getContext} from '@netlify/functions';
import {AppError} from '../../apps/cloud/src/errors';
import {postgresStorage,type SqlPool} from '../../apps/cloud/src/postgres-storage';
import {postgresRepository} from '../../apps/cloud/src/postgres-repository';
import type {NetlifyUser} from '../../apps/cloud/src/netlify-http';
import type {IdentityContext} from '../../apps/cloud/src/identity';
import {createWorkspaceApi,guestCookie,guestIdentity} from '../../apps/cloud/src/anonymous-http';
import {anonymousWorkspaces,type GuestRef} from '../../apps/cloud/src/anonymous-workspace';
import {guestAiRepository} from '../../apps/cloud/src/guest-ai';
import {createGateway} from '../../apps/cloud/src/gateway';
import {bookmarksService} from '../../apps/cloud/src/bookmarks';
import {aiService} from '../../apps/cloud/src/ai-service';
import {assistantService} from '../../apps/cloud/src/assistant-service';
import {siteWorkspace,requireSiteUser} from '../../apps/cloud/src/site-access';
import {schoolRequests} from '../../apps/cloud/src/school-requests';
import {reminderService} from '../../apps/cloud/src/reminders';
import {reminderRuntime} from '../../apps/cloud/src/netlify-reminder-runtime';
import {providerProfiles} from '../../apps/cloud/src/ai-provider-profiles';
import {materialRuntime} from '../../apps/cloud/src/material-runtime';
declare const Netlify:{env:{get(name:string):string|undefined}};
let pool:SqlPool|undefined;
const database=()=>pool ||= getDatabase().pool as unknown as SqlPool;
async function run(event:unknown,user:NetlifyUser|null,guest:GuestRef|null,aiRequest=false){
 const pool=database(),db=postgresStorage(pool),base=postgresRepository(pool),context=getContext();
 const account=user?siteWorkspace(user,Netlify.env.get('NETLIFY_OWNER_EMAIL')):null;
 const workspace=guest&&!aiRequest?{ownerUid:guest.owner,dataOwnerId:guest.owner,guestWorkspace:true}:account!;
 const repo=guest&&aiRequest?guestAiRepository(base,account!.dataOwnerId,guest.owner):base;
 const {directory,websites,publicSources}=materialRuntime(pool,repo,{production:context.deploy.context==='production',deployId:context.deploy.id});
 const runtime=reminderRuntime(pool,context.deploy.context==='production');
 const action=(event as {action?:unknown})?.action;
 if(!guest&&user&&typeof action==='string'&&action.startsWith('reminders.'))await runtime.aliyun.email.bind(workspace.dataOwnerId,user.id,user.email);
 let aiHandler:((action:any,input:any,identity:IdentityContext)=>Promise<any>)|undefined;
 if(typeof action==='string'&&action.startsWith('ai.')){
  for(const key of ['AI_CHAT_API_KEY','AI_DAILY_LIMIT','AI_PLATFORM_DAILY_CALLS','AI_PLATFORM_DAILY_TOKENS','TAVILY_API_KEY']){const value=Netlify.env.get(key);if(value!==undefined)process.env[key]=value;}
  process.env.AI_CHAT_BASE_URL=Netlify.env.get('AI_CHAT_BASE_URL')||'https://api.deepseek.com';
  process.env.AI_CHAT_MODEL=Netlify.env.get('AI_CHAT_MODEL')||'deepseek-flash';process.env.AI_EXECUTION_MODE='direct';process.env.AI_PROVIDER='openai_compatible';
  const providers=providerProfiles(pool,{encryptionKey:()=>Netlify.env.get('AI_PROVIDER_ENCRYPTION_KEY')});
  const ai=aiService(db,repo,undefined,undefined,undefined,providers),assistant=assistantService(db,repo,ai,undefined,undefined,undefined,providers);
  aiHandler=(action,input,identity)=>assistant.supports(action)?assistant.handle(action,input,identity):ai.handle(action,input,identity);
 }
 const requestSchool=schoolRequests(pool,async fields=>{
  const response=await fetch('https://campus-reader-ninie6159.netlify.app/__forms.html',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:fields.toString(),redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error('Form submission not confirmed');
 });
 const gateway=createGateway(repo,workspace,Date.now,{
  reminders:reminderService(pool,runtime),websites:{handle:(action,input,identity)=>publicSources.supports(action)?publicSources.handle(action,input,identity):websites.handle(action,input,identity)},bookmarks:bookmarksService(db,repo),
  ...(aiHandler?{ai:{handle:aiHandler}}:{}),
  directory:{refresh:directory.refresh,sources:directory.sources,request:async(name,identity)=>{
   if(context.deploy.context!=='production')throw new AppError('PRODUCTION_REQUIRED','请在正式网站提交学校添加申请；预览环境不发送通知。');
   const email=user?.email||await runtime.aliyun.email.verifiedAddress(identity.dataOwnerId);
   if(!email)throw new AppError('EMAIL_NOT_READY','请先在提醒中心填写并验证邮箱，再提交学校添加申请。');
   return requestSchool(name,identity.dataOwnerId,email);
  }}
 });
 const result=await gateway(event,{uid:workspace.ownerUid,isAnonymous:Boolean(guest&&!aiRequest)});
 if(result.ok&&guest&&!aiRequest&&(action==='session.get'||action==='school.select')){
  const session=result.data as import('@campus/contracts').WorkspaceSession;session.identity=guestIdentity(guest,user);session.capabilities.ai=Boolean(user);
 }
 return result;
}
export default createWorkspaceApi({
 async account(){const user=await getUser();return user?.email?requireSiteUser({id:user.id,email:user.email},Netlify.env.get('NETLIFY_OWNER_EMAIL')):null;},
 guest:request=>{const token=guestCookie(request);return token?anonymousWorkspaces(database()).resolve(token):Promise.resolve(null);},
 legacy:(event,user)=>run(event,user,null),public:(event,guest,user)=>run(event,user,guest),ai:(event,guest,user)=>run(event,user,guest,true)
});
