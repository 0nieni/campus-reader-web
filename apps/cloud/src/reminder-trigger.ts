import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
export const reminderTickUrl='https://campus-reader-ninie6159.netlify.app/.netlify/functions/reminder-tick';
export function triggerSecrets(get:(name:string)=>string|undefined){
 return [get('REMINDER_TRIGGER_SECRET'),get('REMINDER_TRIGGER_SECRET_NEXT')].filter((s):s is string=>Boolean(s&&s.length>=32&&s.length<=256));
}
export function triggerSignature(secret:string,timestamp:string,requestId:string,raw:string){
 const canonical=['POST',new URL(reminderTickUrl).pathname,timestamp,requestId,createHash('sha256').update(raw).digest('hex')].join('\n');
 return createHmac('sha256',secret).update(canonical).digest('hex');
}
export function createMinuteTrigger(options:{production:()=>boolean;enabled:()=>boolean;secrets:()=>string[];run:()=>Promise<unknown>;now?:()=>number}){
 return async(request:Request)=>{
  const reply=(status:number)=>new Response(null,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
  if(request.method!=='POST')return reply(405);
  if(!options.production()||!options.enabled())return reply(503);
  const secrets=options.secrets();if(!secrets.length)return reply(503);
  if(request.url!==reminderTickUrl)return reply(401);
  const timestamp=request.headers.get('x-reminder-time')||'',id=request.headers.get('x-reminder-request')||'',signature=request.headers.get('x-reminder-signature')||'';
  if(!/^\d{13}$/.test(timestamp)||Math.abs((options.now||Date.now)()-Number(timestamp))>120000||! /^[a-f0-9]{32}$/.test(id)||! /^[a-f0-9]{64}$/.test(signature))return reply(401);
  if(request.headers.get('content-type')!=='application/json')return reply(400);
  const reader=request.body?.getReader();if(!reader)return reply(400);const parts:Uint8Array[]=[];let length=0;
  try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>128){await reader.cancel();return reply(413);}parts.push(part.value);}}catch{return reply(400);}
  const raw=Buffer.concat(parts).toString('utf8');
  if(!secrets.some(secret=>timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(triggerSignature(secret,timestamp,id,raw),'hex'))))return reply(401);
  if(raw!=='{}')return reply(400);
  try{await options.run();return reply(204);}catch{console.error(JSON.stringify({event:'reminder-tick',state:'failed'}));return reply(503);}
 };
}
