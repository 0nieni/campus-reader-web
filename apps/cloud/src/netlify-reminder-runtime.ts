import {admin} from '@netlify/identity';
import type {SqlPool} from './postgres-storage';
import {netlifyWakeStore} from './reminder-index';
import {directMailConfig,directMailSender} from './directmail';
import {reminderEmail} from './reminder-email';
import {triggerSecrets} from './reminder-trigger';
declare const Netlify:{env:{get(name:string):string|undefined}};
export const schedulerEnabled=()=>Netlify.env.get('REMINDER_SCHEDULER')==='aliyun-fc'&&triggerSecrets(name=>Netlify.env.get(name)).length>0;
export function reminderRuntime(pool:SqlPool,production:boolean){
 const publicKey=production?Netlify.env.get('WEB_PUSH_PUBLIC_KEY'):undefined,privateKey=production?Netlify.env.get('WEB_PUSH_PRIVATE_KEY'):undefined;
 const mail=production?directMailConfig(name=>Netlify.env.get(name)):undefined;
 return{
  push:publicKey&&privateKey?{publicKey,privateKey,subject:'https://campus-reader-ninie6159.netlify.app'}:undefined,
  minuteMode:true,
  aliyun:{
   index:production&&schedulerEnabled()?netlifyWakeStore():undefined,
   email:reminderEmail(pool,{sender:mail?directMailSender(mail):undefined,dailyLimit:mail?.dailyLimit,resolveIdentity:async id=>admin.getUser(id)})
  }
 };
}
