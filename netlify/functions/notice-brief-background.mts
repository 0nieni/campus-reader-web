import {getContext} from '@netlify/functions';
import {getDatabase} from '@netlify/database';
import type {SqlPool} from '../../apps/cloud/src/postgres-storage';
import {noticeBriefRuntime,validBriefJob} from '../../apps/cloud/src/notice-brief-runtime';
export const config={background:true};
export default async(request:Request)=>{
 const context=getContext();if(context.deploy.context!=='production'||request.method!=='POST'||Number(request.headers.get('content-length'))>16)return;
 const reader=request.body?.getReader();if(!reader)return;let body='',bytes=0;
 for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>16){await reader.cancel();return;}body+=new TextDecoder().decode(chunk.value);}
 if(body!=='{}'||!validBriefJob(Netlify.env.get('MATERIALS_JOB_SECRET'),request.headers.get('x-brief-time'),request.headers.get('x-brief-signature')))return;
 const jobs=noticeBriefRuntime(getDatabase().pool as unknown as SqlPool,{production:true,deployId:context.deploy.id});
 const result=await jobs.run();console.info(JSON.stringify({event:'notice-brief-worker',processed:result.processed,more:result.more}));
};
