import {getDatabase} from '@netlify/database';
import {getUser} from '@netlify/identity';
import {getContext} from '@netlify/functions';
import type {SqlPool} from '../../apps/cloud/src/postgres-storage';
import {anonymousWorkspaces} from '../../apps/cloud/src/anonymous-workspace';
import {createAnonymousHttp} from '../../apps/cloud/src/anonymous-http';
let pool:SqlPool|undefined;
export default async(request:Request)=>{
 pool||=getDatabase().pool as unknown as SqlPool;
 return createAnonymousHttp({workspaces:anonymousWorkspaces(pool),account:async()=>{const user=await getUser();return user?.email?{id:user.id,email:user.email}:null;},address:()=>getContext().ip||'unknown'})(request);
};
