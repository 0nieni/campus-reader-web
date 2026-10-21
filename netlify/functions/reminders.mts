import {getDatabase} from '@netlify/database';
import {getContext} from '@netlify/functions';
import {runReminderTick} from '../../apps/cloud/src/reminders';
import type {SqlPool} from '../../apps/cloud/src/postgres-storage';
import {reminderRuntime,schedulerEnabled} from '../../apps/cloud/src/netlify-reminder-runtime';
// Beijing 09:00 / 20:00 bounded index repair; normal delivery uses FC ticks.
export const config={schedule:'0 1,12 * * *'};
export default async()=>{
  if(getContext().deploy.context!=='production'||!schedulerEnabled())return new Response(null,{status:204});
  const pool=getDatabase().pool as unknown as SqlPool,result=await runReminderTick(pool,reminderRuntime(pool,true));
  console.info(JSON.stringify({event:'reminder-repair',...result}));
  return new Response(null,{status:204});
};
