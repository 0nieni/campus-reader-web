import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {McpScope} from '@campus/contracts';
import {mcpScopes} from '../../../packages/contracts/src/index';
import type {SqlExecutor,SqlPool,SqlClient} from './postgres-storage';
import {AppError} from './errors';
export const mcpHash=(value:string)=>createHash('sha256').update(value).digest('hex');
export const mcpRandom=()=>randomBytes(32).toString('base64url');
export const mcpId=()=>randomUUID().replace(/-/g,'');
export const mcpIso=(time:number)=>new Date(time).toISOString();
export function mcpFail(code:string,message:string):never{throw new AppError(code,message);}
export const mcpEqual=(a:string,b:string)=>timingSafeEqual(Buffer.from(mcpHash(a)),Buffer.from(mcpHash(b)));
export const mcpDefaultScopes:McpScope[]=['announcements:read','bookmarks:read','reminders:read','offline_access'];
export function checkedMcpScopes(value:unknown,defaults=false):McpScope[]{
 const rows=value===undefined&&defaults?mcpDefaultScopes:typeof value==='string'?value.trim().split(/\s+/):value;
 if(!Array.isArray(rows)||!rows.length||rows.length>6||rows.some(scope=>typeof scope!=='string'||![...mcpScopes,'offline_access'].includes(scope as any)))mcpFail('invalid_scope','请选择有效的MCP权限范围。');
 const result=[...new Set(rows as string[])] as McpScope[];
 if(!result.length)mcpFail('invalid_scope','至少需要一项资料访问权限。');return result;
}
export function mcpRedirect(value:unknown){
 if(typeof value!=='string'||value.length>1800)mcpFail('invalid_redirect_uri','回调地址无效。');
 let url:URL;try{url=new URL(value as string);}catch{return mcpFail('invalid_redirect_uri','回调地址无效。');}
 const loopback=url.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(url.hostname);
 if(url.username||url.password||url.hash||url.searchParams.has('code')||url.searchParams.has('access_token')||(!loopback&&url.protocol!=='https:'))mcpFail('invalid_redirect_uri','回调地址必须为HTTPS或本机回环地址。');
 return value as string;
}
export function mcpRedirectMatches(registered:string,requested:string){
 if(registered===requested)return true;
 const a=new URL(registered),b=new URL(requested),loopback=['127.0.0.1','[::1]','localhost'];
 return a.protocol==='http:'&&b.protocol==='http:'&&loopback.includes(a.hostname)&&a.hostname===b.hostname&&a.pathname===b.pathname&&a.search===b.search;
}
export async function mcpLimit(sql:SqlExecutor,kind:string,subject:string,maximum:number,now:number,window=60000){
 const start=Math.floor(now/window)*window;
 const result=await sql.query(`INSERT INTO campus_mcp_limits(bucket,subject,used,expires_at) VALUES($1,$2,1,$3)
 ON CONFLICT(bucket,subject) DO UPDATE SET used=campus_mcp_limits.used+1 WHERE campus_mcp_limits.used<$4 RETURNING used`,[kind+':'+start,mcpHash(subject),mcpIso(start+window*2),maximum]);
 if(!result.rows.length)mcpFail('rate_limited','MCP请求过于频繁，请稍后重试。');
}
export async function mcpTransaction<T>(pool:SqlPool,run:(sql:SqlClient)=>Promise<T>){
 const sql=await pool.connect();try{await sql.query('BEGIN');await sql.query("SET LOCAL statement_timeout='10000'");const result=await run(sql);await sql.query('COMMIT');return result;}
 catch(error){await sql.query('ROLLBACK').catch(()=>{});throw error;}finally{sql.release();}
}
/** Services retain their own transaction APIs; the MCP receipt owns this single
 * outer transaction. An exception always propagates to its real rollback. */
export function mcpTransactionPool(sql:SqlClient):SqlPool{
 const client:SqlClient={query:(query,args)=>/^(BEGIN|COMMIT|ROLLBACK)$/i.test(query.trim())?Promise.resolve({rows:[]}):sql.query(query,args),release(){}};
 return{query:client.query,connect:async()=>client};
}
