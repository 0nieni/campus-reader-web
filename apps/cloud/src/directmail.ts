import DmSdk,{SingleSendMailRequest,SenderStatisticsDetailByParamRequest} from '@alicloud/dm20151123';
import {$OpenApiUtil} from '@alicloud/openapi-core';
import {RuntimeOptions} from '@darabonba/typescript';
import {normalizedEmail} from './site-access';
export interface MailResult {state:'accepted'|'temporary'|'failed'|'unknown';id?:string;code?:string;invalid?:boolean}
export interface MailSender {
 send(to:string,subject:string,text:string):Promise<MailResult>;
 suppressed?(to:string,since:number):Promise<boolean>;
}
export interface DirectMailConfig {accessKeyId:string;accessKeySecret:string;region:string;accountName:string;fromAlias:string;dailyLimit:number}
export function directMailConfig(get:(name:string)=>string|undefined):DirectMailConfig|undefined{
 if(get('REMINDER_EMAIL_ENABLED')!=='true')return;
 const accessKeyId=get('DIRECTMAIL_ACCESS_KEY_ID'),accessKeySecret=get('DIRECTMAIL_ACCESS_KEY_SECRET'),region=get('DIRECTMAIL_REGION'),accountName=normalizedEmail(get('DIRECTMAIL_ACCOUNT_NAME')),fromAlias=get('DIRECTMAIL_FROM_ALIAS')||'校园阅览室';
 // The locked 2015-11-23 SDK targets Hangzhou. Other regions require the
 // corresponding official API version, rather than guessing at endpoints.
 if(!accessKeyId||!accessKeySecret||region!=='cn-hangzhou'||!accountName||fromAlias.length>15||/[\r\n]/.test(fromAlias))return;
 const limit=get('REMINDER_EMAIL_DAILY_LIMIT')||'150';if(!/^\d{1,4}$/.test(limit)||Number(limit)<1||Number(limit)>150)return;
 return{accessKeyId,accessKeySecret,region,accountName,fromAlias,dailyLimit:Number(limit)};
}
export function directMailSender(config:DirectMailConfig,sdk?:Pick<InstanceType<typeof DmSdk>,'singleSendMailWithOptions'|'senderStatisticsDetailByParamWithOptions'>):MailSender {
 // Normalize the official CommonJS SDK in Node ESM as well as esbuild output.
 const Client=(DmSdk as unknown as {default?:typeof DmSdk}).default||DmSdk;
 const client=sdk||new Client(new $OpenApiUtil.Config({accessKeyId:config.accessKeyId,accessKeySecret:config.accessKeySecret,regionId:config.region,endpoint:'dm.aliyuncs.com',protocol:'HTTPS'}));
 const runtime=()=>new RuntimeOptions({autoretry:false,maxAttempts:1,readTimeout:3500,connectTimeout:1500});
 return{
  async send(to,subject,text){
   if(!normalizedEmail(to))return{state:'failed',code:'invalid_address',invalid:true};
   try{
    const result=await client.singleSendMailWithOptions(new SingleSendMailRequest({accountName:config.accountName,addressType:1,replyToAddress:false,toAddress:to,subject,textBody:text,fromAlias:config.fromAlias,clickTrace:'0'}),runtime());
    const id=result.body?.envId||result.body?.requestId;
    return id?{state:'accepted',id:String(id).slice(0,100)}:{state:'unknown',code:'response_unconfirmed'};
   }catch(error){
    const e=error as {code?:string;statusCode?:number},code=typeof e.code==='string'?e.code:'';
    const invalid=['InvalidReceiverName.Malformed','InvalidReceiver.NotFound','InvalidToAddress','InvalidToAddress.Spam'].includes(code);
    if(!e.statusCode)return{state:'unknown',code:'network_unknown'};
    const temporary=/^(Throttling|LimitExceeded|ServiceUnavailable|InternalError|InternalServiceError)/.test(code);
    return{state:temporary?'temporary':'failed',invalid,code:invalid?'invalid_address':temporary?'provider_temporary':'provider_rejected'};
   }
  },
  async suppressed(to,since){
   const date=(n:number)=>new Date(n).toISOString().slice(0,16).replace('T',' ');
   const results=await Promise.all([2,3].map(status=>client.senderStatisticsDetailByParamWithOptions(new SenderStatisticsDetailByParamRequest({toAddress:to,status,startTime:date(Math.max(Date.now()-7*86400000,since)),endTime:date(Date.now()+60000),length:100}),runtime())));
   // This query does not reliably identify individual accepted messages. Use
   // verified address-level hard bounce/complaint feedback only to pause mail.
   return results.some(result=>Boolean(result.body?.data?.mailDetail?.some(row=>row.toAddress?.toLowerCase()===to&&row.accountName?.toLowerCase()===config.accountName&&[2,3].includes(Number(row.status)))));
  }
 };
}
