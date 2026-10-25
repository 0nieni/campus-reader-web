import {getUser} from '@netlify/identity';
import {getContext} from '@netlify/functions';
import {getDatabase} from '@netlify/database';
import type {SqlPool} from '../../apps/cloud/src/postgres-storage';
import {postgresRepository} from '../../apps/cloud/src/postgres-repository';
import {materialRuntime} from '../../apps/cloud/src/material-runtime';
import {materialFile} from '../../apps/cloud/src/material-file';
import {siteWorkspace,requireSiteUser} from '../../apps/cloud/src/site-access';
export default async(request:Request)=>{
 try{
  const identity=await getUser(),email=Netlify.env.get('NETLIFY_OWNER_EMAIL');
  const user=requireSiteUser(identity?.email?{id:identity.id,email:identity.email}:null,email);
  const pool=getDatabase().pool as unknown as SqlPool,repo=postgresRepository(pool),context=getContext();
  const runtime=materialRuntime(pool,repo,{production:context.deploy.context==='production',deployId:context.deploy.id});
  return materialFile(request,siteWorkspace(user,email).dataOwnerId,repo,runtime.archive,runtime.source);
 }catch{return Response.json({ok:false,message:'请先登录后下载资料。'},{status:401,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});}
};
