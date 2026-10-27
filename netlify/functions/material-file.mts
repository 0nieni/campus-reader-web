import {getUser} from '@netlify/identity';
import {getContext} from '@netlify/functions';
import {getDatabase} from '@netlify/database';
import type {SqlPool} from '../../apps/cloud/src/postgres-storage';
import {postgresRepository} from '../../apps/cloud/src/postgres-repository';
import {materialRuntime} from '../../apps/cloud/src/material-runtime';
import {materialFile} from '../../apps/cloud/src/material-file';
import {siteWorkspace,requireSiteUser} from '../../apps/cloud/src/site-access';
import {anonymousWorkspaces} from '../../apps/cloud/src/anonymous-workspace';
import {guestCookie} from '../../apps/cloud/src/anonymous-http';
export default async(request:Request)=>{
 try{
  const pool=getDatabase().pool as unknown as SqlPool,repo=postgresRepository(pool),context=getContext();
  const guest=await anonymousWorkspaces(pool).resolve(guestCookie(request));
  let owner:string;
  if(new URL(request.url).searchParams.get('workspace')==='account'){const identity=await getUser(),email=Netlify.env.get('NETLIFY_OWNER_EMAIL');const user=requireSiteUser(identity?.email?{id:identity.id,email:identity.email}:null,email);owner=siteWorkspace(user,email).dataOwnerId;}
  else{if(!guest)throw Error('Guest session required');owner=guest.owner;}
  const runtime=materialRuntime(pool,repo,{production:context.deploy.context==='production',deployId:context.deploy.id});
  return materialFile(request,owner,repo,runtime.archive,runtime.source);
 }catch{return Response.json({ok:false,message:'工作区身份已失效，请刷新页面后重试。'},{status:401,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});}
};
