import {createHash,timingSafeEqual} from 'node:crypto';
import type {SqlPool} from './postgres-storage';
import {competitionDirectory} from './competition-directory';
import {AppError} from './errors';
import {boundedJson} from './netlify-http';

export const SOURCE_AUDIT_RUN='navigation-6ef8a4dd-20261104';
const expires=Date.parse('2026-11-05T16:00:00Z'); // 2026-11-06 00:00 Beijing.
const targets=new Set([...competitionDirectory.map(source=>source.id),'school_bjtu']);
const valid=(target:unknown):target is string=>typeof target==='string'&&targets.has(target);
const digest=(value:string)=>createHash('sha256').update(value).digest();
declare const Netlify:{env:{get(name:string):string|undefined}};
export function sourceAuditKey(){return process.env.SOURCE_DIRECTORY_AUDIT_KEY_20261104||(typeof Netlify==='undefined'?undefined:Netlify.env.get('SOURCE_DIRECTORY_AUDIT_KEY_20261104'));}

/** Operator-only, one-off fixed catalogue. A claimed target is never retried,
 * including after a failure or an ambiguous client timeout. No personal scope. */
export function sourceDirectoryAudit(pool:SqlPool,collect:(target:string)=>Promise<unknown>,now=Date.now){
 return async(target:string)=>{
  if(!valid(target))throw new AppError('VALIDATION_FAILED','目标不在本次固定来源目录中。');
  const id=`__audit_${SOURCE_AUDIT_RUN}_${target}`,at=new Date(now()).toISOString();
  const claim=await pool.query("INSERT INTO campus_documents(collection,id,body) VALUES('school_sync',$1,$2::jsonb) ON CONFLICT DO NOTHING RETURNING id",[id,JSON.stringify({auditRun:SOURCE_AUDIT_RUN,target,state:'checking',startedAt:at})]);
  if(!claim.rows.length){const prior=(await pool.query("SELECT body FROM campus_documents WHERE collection='school_sync' AND id=$1",[id])).rows[0]?.body;return{...prior?.result,target,state:prior?.state||'checking',cached:true};}
  let result:Record<string,unknown>;
  try{result={target,state:'ready',data:await collect(target)};}
  catch(error){result={target,state:'failed',code:error instanceof AppError?error.code:'COLLECTION_FAILED',message:error instanceof AppError?error.message:'本次维护采集未完成；不自动重试，已有公告保留。'};}
  await pool.query("UPDATE campus_documents SET body=body || $2::jsonb WHERE collection='school_sync' AND id=$1",[id,JSON.stringify({state:result.state,result,finishedAt:new Date(now()).toISOString()})]);
  return{...result,cached:false};
 };
}

export function auditHttp(options:{key():string|undefined;production():boolean;run(target:string):Promise<unknown>;now?:()=>number}){
 const respond=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
 return async(request:Request)=>{
  if(request.method!=='POST')return respond({ok:false,code:'ACTION_NOT_ALLOWED'},405);
  const key=options.key(),provided=request.headers.get('x-source-audit-key')||'';
  if(!key||!/^[A-Za-z0-9_-]{43}$/.test(key))return respond({ok:false,code:'MAINTENANCE_NOT_CONFIGURED'},403);
  if(!/^[A-Za-z0-9_-]{43}$/.test(provided)||!timingSafeEqual(digest(key),digest(provided)))return respond({ok:false,code:'FORBIDDEN'},403);
  if((options.now||Date.now)()>=expires)return respond({ok:false,code:'MAINTENANCE_EXPIRED'},403);
  if(!options.production())return respond({ok:false,code:'PRODUCTION_REQUIRED'},403);
  try{
   const body=await boundedJson(request,256);
   if(Object.keys(body).length!==1||!valid(body.target))return respond({ok:false,code:'VALIDATION_FAILED'},400);
   return respond({ok:true,run:SOURCE_AUDIT_RUN,data:await options.run(body.target)});
  }catch(error){return respond({ok:false,code:error instanceof AppError?error.code:'MAINTENANCE_UNAVAILABLE'},error instanceof AppError?400:503);}
 };
}
