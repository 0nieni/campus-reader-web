import {getDatabase} from '@netlify/database';
import {getContext} from '@netlify/functions';
import type {SqlPool} from '../../apps/cloud/src/postgres-storage';
import {reminderService} from '../../apps/cloud/src/reminders';
import {createReminderCallback,qstashConfig} from '../../apps/cloud/src/qstash';
declare const Netlify:{env:{get(name:string):string|undefined}};
let pool:SqlPool|undefined;
export default createReminderCallback({
 production:()=>getContext().deploy.context==='production',
 config:()=>{
  if(!Netlify.env.get('WEB_PUSH_PUBLIC_KEY')||!Netlify.env.get('WEB_PUSH_PRIVATE_KEY'))return;
  return qstashConfig(name=>Netlify.env.get(name));
 },
 async deliver(jobId){
  const publicKey=Netlify.env.get('WEB_PUSH_PUBLIC_KEY')!,privateKey=Netlify.env.get('WEB_PUSH_PRIVATE_KEY')!;
  pool||=getDatabase().pool as unknown as SqlPool;
  const result=await reminderService(pool,{minuteMode:true,push:{publicKey,privateKey,subject:'https://campus-reader-ninie6159.netlify.app'}}).runJob(jobId);
  console.info(JSON.stringify({event:'minute-reminder',...result}));
 }
});
