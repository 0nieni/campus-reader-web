import {getDatabase} from '@netlify/database';
import {getContext} from '@netlify/functions';
import type {SqlPool} from '../../apps/cloud/src/postgres-storage';
import {mcpAuthorization} from '../../apps/cloud/src/mcp-auth';
import {createMcpOAuthHttp} from '../../apps/cloud/src/mcp-auth-http';
let pool:SqlPool|undefined;
export default async(request:Request)=>{
 const context=getContext();pool||=getDatabase().pool as unknown as SqlPool;
 const origin=context.deploy.context==='production'?'https://campus-reader-ninie6159.netlify.app':new URL(request.url).origin;
 return createMcpOAuthHttp({auth:mcpAuthorization(pool,{origin}),address:()=>context.ip||'unknown'})(request);
};
