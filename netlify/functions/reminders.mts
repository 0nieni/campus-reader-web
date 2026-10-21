import {getDatabase} from '@netlify/database';
import {runReminderTick} from '../../apps/cloud/src/reminders';
import type {SqlPool} from '../../apps/cloud/src/postgres-storage';
import {qstashConfig,qstashPublisher} from '../../apps/cloud/src/qstash';
declare const Netlify:{env:{get(name:string):string|undefined}};
// Twice-daily outbox repair; per-reminder delivery uses signed QStash callbacks.
export const config={schedule:'0 1,12 * * *'};
export default async()=>{
  const publicKey=Netlify.env.get('WEB_PUSH_PUBLIC_KEY'),privateKey=Netlify.env.get('WEB_PUSH_PRIVATE_KEY');
  if(!publicKey||!privateKey)return new Response(null,{status:204});
  const queue=qstashConfig(name=>Netlify.env.get(name));if(!queue)return new Response(null,{status:204});
  const result=await runReminderTick(getDatabase().pool as unknown as SqlPool,{minuteMode:true,queue:qstashPublisher(queue),push:{publicKey,privateKey,subject:'https://campus-reader-ninie6159.netlify.app'}});
  console.info(JSON.stringify({event:'web-reminders',...result}));
  return new Response(null,{status:204});
};
