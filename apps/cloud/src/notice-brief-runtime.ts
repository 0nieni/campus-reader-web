import {createHmac,timingSafeEqual} from 'node:crypto';
import type {SqlPool} from './postgres-storage';
import type {ItemRow} from './repository';
import {noticeBriefJobs} from './notice-brief-jobs';
import {officialConfig} from './ai-service';
import {modelCompletion} from './model-provider';
declare const Netlify:{env:{get(key:string):string|undefined}};
export const BRIEF_JOB_PATH='/.netlify/functions/notice-brief-background';
const env=(key:string)=>typeof Netlify!=='undefined'?Netlify.env.get(key):process.env[key];
export function briefSignature(secret:string,at:string){return createHmac('sha256',secret).update(`POST\n${BRIEF_JOB_PATH}\n${at}\n{}`).digest('hex');}
export function validBriefJob(secret:string|undefined,at:string|null,signature:string|null,now=Date.now()){
 if(!secret||secret.length<32||!at||!/^\d{13}$/.test(at)||Math.abs(now-Number(at))>300000||!signature||!/^[a-f0-9]{64}$/.test(signature))return false;
 return timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(briefSignature(secret,at),'hex'));
}
async function dispatch(){
 const origin=env('URL'),secret=env('MATERIALS_JOB_SECRET');if(!origin||!secret||secret.length<32)throw Error('BRIEF_DISPATCH_NOT_CONFIGURED');
 const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/')throw Error('BRIEF_ORIGIN_INVALID');
 const at=String(Date.now()),response=await fetch(new URL(BRIEF_JOB_PATH,url),{method:'POST',headers:{'content-type':'application/json','x-brief-time':at,'x-brief-signature':briefSignature(secret,at)},body:'{}',redirect:'error',signal:AbortSignal.timeout(2500)});
 if(response.status!==202)throw Error('BRIEF_DISPATCH_FAILED');
}
export const briefSchool=(row:ItemRow,school:string)=>row.scope==='global'?'global':row.schoolIds?.[0]||school;
export function noticeBriefRuntime(pool:SqlPool,context:{production:boolean;deployId:string}){
 const bounded=(key:string,fallback:number,max:number)=>{const value=Number(env(key)??fallback);return Number.isFinite(value)?Math.max(0,Math.min(max,Math.floor(value))):fallback;};
 return noticeBriefJobs(pool,{scope:context.production?'production-v1':`preview-${context.deployId}`,enabled:()=>context.production&&env('NOTICE_BRIEF_ENABLED')==='true',model:()=>officialConfig({AI_CHAT_BASE_URL:env('AI_CHAT_BASE_URL')||'https://api.deepseek.com',AI_CHAT_API_KEY:env('AI_CHAT_API_KEY'),AI_CHAT_MODEL:env('AI_CHAT_MODEL')||'deepseek-flash',AI_PROVIDER:env('AI_PROVIDER')}),complete:modelCompletion,dailyCalls:bounded('NOTICE_BRIEF_DAILY_CALLS',100,100),dailyTokens:bounded('NOTICE_BRIEF_DAILY_TOKENS',1000000,10000000),dispatch});
}
