import {getDatabase} from '@netlify/database';
import {getContext} from '@netlify/functions';
import type {SqlPool} from '../../apps/cloud/src/postgres-storage';
import {mcpAuthorization} from '../../apps/cloud/src/mcp-auth';
import {createMcpManagementHttp} from '../../apps/cloud/src/mcp-auth-http';
import {anonymousWorkspaces} from '../../apps/cloud/src/anonymous-workspace';
import {guestCookie} from '../../apps/cloud/src/anonymous-http';
let pool:SqlPool|undefined;
export default async(request:Request)=>{
 pool||=getDatabase().pool as unknown as SqlPool;
 const origin=getContext().deploy.context==='production'?'https://campus-reader-ninie6159.netlify.app':new URL(request.url).origin;
 return createMcpManagementHttp({auth:mcpAuthorization(pool,{origin}),guest:request=>anonymousWorkspaces(pool!).resolve(guestCookie(request))})(request);
};
