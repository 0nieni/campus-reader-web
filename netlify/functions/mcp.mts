import {getDatabase} from '@netlify/database';
import {getContext} from '@netlify/functions';
import type {SqlPool} from '../../apps/cloud/src/postgres-storage';
import {mcpAuthorization} from '../../apps/cloud/src/mcp-auth';
import {mcpWorkspaceTools} from '../../apps/cloud/src/mcp-tools';
import {createCampusMcpHttp} from '../../apps/cloud/src/mcp-http';
import {reminderRuntime} from '../../apps/cloud/src/netlify-reminder-runtime';
import {reminderService} from '../../apps/cloud/src/reminders';
let pool:SqlPool|undefined;
export default async(request:Request)=>{
 const context=getContext(),production=context.deploy.context==='production';pool||=getDatabase().pool as unknown as SqlPool;
 const origin=production?'https://campus-reader-ninie6159.netlify.app':new URL(request.url).origin;
 const auth=mcpAuthorization(pool,{origin}),runtime=reminderRuntime(pool,production);
 const tools=mcpWorkspaceTools(pool,{auth,reminders:runtime,afterWrite:()=>reminderService(pool!,runtime).aliyun!.register()});
 return createCampusMcpHttp({pool,auth,tools,address:()=>context.ip||'unknown'})(request);
};
