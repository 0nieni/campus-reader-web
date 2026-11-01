import {getContext} from '@netlify/functions';
import {getDatabase} from '@netlify/database';
import type {SqlPool} from '../../apps/cloud/src/postgres-storage';
import {validBriefJob} from '../../apps/cloud/src/notice-brief-runtime';
import {materialRuntime} from '../../apps/cloud/src/material-runtime';
import {postgresRepository} from '../../apps/cloud/src/postgres-repository';
export const config={background:true};
export default async(request:Request)=>{
 const context=getContext();if(context.deploy.context!=='production'||request.method!=='POST'||Number(request.headers.get('content-length'))>16)return;
 const reader=request.body?.getReader();if(!reader)return;let body='',bytes=0;
 for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>16){await reader.cancel();return;}body+=new TextDecoder().decode(chunk.value);}
 if(body!=='{}'||!validBriefJob(Netlify.env.get('MATERIALS_JOB_SECRET'),request.headers.get('x-brief-time'),request.headers.get('x-brief-signature')))return;
 const pool=getDatabase().pool as unknown as SqlPool;
 const jobs=materialRuntime(pool,postgresRepository(pool),{production:true,deployId:context.deploy.id}).briefs;
 const result=await jobs.run();console.info(JSON.stringify({event:'notice-brief-worker',processed:result.processed,more:result.more}));
};
