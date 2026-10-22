import {getDatabase} from '@netlify/database';
import {getContext} from '@netlify/functions';
import type {SqlPool} from '../../apps/cloud/src/postgres-storage';
import {createEmailPage} from '../../apps/cloud/src/reminder-email-page';
import {reminderRuntime} from '../../apps/cloud/src/netlify-reminder-runtime';
export default createEmailPage({production:()=>getContext().deploy.context==='production',consume:async(kind,token)=>{
 const pool=getDatabase().pool as unknown as SqlPool;
 return reminderRuntime(pool,true).aliyun.email.consume(kind,token);
}});
