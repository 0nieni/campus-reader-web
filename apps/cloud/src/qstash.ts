import {Receiver} from '@upstash/qstash';
import type {ReminderPublisher} from './reminder-jobs';
export const reminderCallback='https://campus-reader-ninie6159.netlify.app/.netlify/functions/reminder-delivery';
export interface QstashConfig {token:string;currentSigningKey:string;nextSigningKey:string;baseUrl:string}
export function qstashConfig(get:(name:string)=>string|undefined):QstashConfig|undefined{
 const token=get('QSTASH_TOKEN'),currentSigningKey=get('QSTASH_CURRENT_SIGNING_KEY'),nextSigningKey=get('QSTASH_NEXT_SIGNING_KEY');
 if(!token||!currentSigningKey||!nextSigningKey)return;
 let url:URL;try{url=new URL(get('QSTASH_URL')||'https://qstash.upstash.io');}catch{return;}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash||!/^qstash(?:-[a-z0-9-]+)?\.upstash\.io$/.test(url.hostname))return;
 return{token,currentSigningKey,nextSigningKey,baseUrl:url.origin};
}
export function qstashPublisher(config:QstashConfig,request:typeof fetch=fetch):ReminderPublisher{
 return{async publish(jobId,at){
  const response=await request(`${config.baseUrl}/v2/publish/${reminderCallback}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(3500),headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json','Upstash-Not-Before':String(Math.ceil(at/1000)),'Upstash-Deduplication-Id':jobId,'Upstash-Retries':'1','Upstash-Retry-Delay':'30000','Upstash-Timeout':'20s'},body:JSON.stringify({jobId})});
  if(!response.ok)throw new Error('Queue publication was not confirmed');
  const body=await response.json() as {messageId?:unknown};
  if(typeof body.messageId!=='string'||!body.messageId||body.messageId.length>200)throw new Error('Queue response was not confirmed');
  return body.messageId;
 }};
}
export function createReminderCallback(options:{config:()=>QstashConfig|undefined;production:()=>boolean;deliver:(id:string)=>Promise<unknown>}){
 return async(request:Request)=>{
  const reply=(status:number)=>new Response(null,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
  if(request.method!=='POST')return reply(405);
  if(!options.production())return reply(503);
  const config=options.config();if(!config)return reply(503);
  if(new URL(request.url).href!==reminderCallback)return reply(401);
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return reply(400);
  const reader=request.body?.getReader();if(!reader)return reply(400);
  let length=0;const chunks:Uint8Array[]=[];
  for(;;){const result=await reader.read();if(result.done)break;length+=result.value.length;if(length>256){await reader.cancel();return reply(413);}chunks.push(result.value);}
  const raw=Buffer.concat(chunks).toString('utf8'),signature=request.headers.get('Upstash-Signature');if(!signature)return reply(401);
  try{if(!await new Receiver(config).verify({signature,body:raw,url:reminderCallback}))return reply(401);}catch{return reply(401);}
  let jobId:string;
  try{const value=JSON.parse(raw);if(Object.keys(value).length!==1||typeof value.jobId!=='string'||! /^[a-f0-9]{32}$/.test(value.jobId))return reply(400);jobId=value.jobId;}catch{return reply(400);}
  try{await options.deliver(jobId);return reply(204);}catch{return reply(503);}
 };
}
