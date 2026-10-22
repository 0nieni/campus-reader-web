import {getDatabase} from '@netlify/database';
import {getContext} from '@netlify/functions';
import type {SqlPool} from '../../apps/cloud/src/postgres-storage';
import {createMinuteTrigger,triggerSecrets} from '../../apps/cloud/src/reminder-trigger';
import {minuteTick,netlifyWakeStore} from '../../apps/cloud/src/reminder-index';
import {reminderService} from '../../apps/cloud/src/reminders';
import {reminderRuntime,schedulerEnabled} from '../../apps/cloud/src/netlify-reminder-runtime';
declare const Netlify:{env:{get(name:string):string|undefined}};
export default createMinuteTrigger({
 production:()=>getContext().deploy.context==='production',enabled:schedulerEnabled,secrets:()=>triggerSecrets(name=>Netlify.env.get(name)),
 run:()=>minuteTick({store:netlifyWakeStore(),process:async()=>{
  // Deliberately lazy: the idle branch never creates a database client.
  const pool=getDatabase().pool as unknown as SqlPool;
  return reminderService(pool,reminderRuntime(pool,true)).aliyun!.tick();
 }})
});
