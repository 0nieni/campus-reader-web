import {getContext} from '@netlify/functions';
import {getDatabase} from '@netlify/database';
import type {SqlPool} from '../../apps/cloud/src/postgres-storage';
import {postgresRepository} from '../../apps/cloud/src/postgres-repository';
import {materialRuntime} from '../../apps/cloud/src/material-runtime';
import {schoolDirectory} from '../../apps/cloud/src/school-directory';
import {materialJobs,validJob} from '../../apps/cloud/src/material-jobs';
import {dispatchMaterials} from '../../apps/cloud/src/material-dispatch';
export const config={background:true};
export default async(request:Request)=>{
 const start=Date.now(),context=getContext(),secret=Netlify.env.get('MATERIALS_JOB_SECRET');
 if(context.deploy.context!=='production'||request.method!=='POST'||Number(request.headers.get('content-length'))>256)return;
 const input=request.body?.getReader();if(!input)return;
 let bytes=0,body='';for(;;){const chunk=await input.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>256){await input.cancel();return;}body+=new TextDecoder().decode(chunk.value);}
 if(body!=='{}'||!validJob(secret,request.headers.get('x-material-time'),body,request.headers.get('x-material-signature')))return;
 const pool=getDatabase().pool as unknown as SqlPool,repo=postgresRepository(pool);
 const runtime=materialRuntime(pool,repo,{production:true,deployId:context.deploy.id});
 const directory=schoolDirectory(pool,repo,undefined,Date.now,{trackActivity:false});
 const jobs=materialJobs(pool,{school:directory.refresh,source:async(id,owner,school)=>{
  try{return await runtime.websites.refreshSource(id,owner,school);}catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='SOURCE_INTERVAL')return;throw error;}
 },material:(row,deadline)=>runtime.material(row,{force:true,deadline}),cleanup:()=>runtime.archive.cleanup(100)});
 await jobs.start();const result=await jobs.run(start+12*60000);
 console.info(JSON.stringify({event:'material-collection',...result}));
 if(result.more)await dispatchMaterials(Netlify.env.get('URL'),secret);
};
