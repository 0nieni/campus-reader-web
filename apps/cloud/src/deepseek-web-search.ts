import {isIP} from 'node:net';
import {lookup} from 'node:dns/promises';
import {publicAddress} from './model-provider';
import {AppError} from './errors';

export interface WebPageSource {
  title:string;url:string;publishedAt:string|null;checkedAt:string;
  readState:'body'|'snippet_only'|'unavailable';body?:string;
}
export interface WebSearchResult {state:'unconfigured'|'complete'|'failed';message:string;query:string;sources:WebPageSource[]}
interface Options {fetch?:typeof fetch;lookup?:(hostname:string)=>Promise<Array<{address:string;family:number}>>;now?:()=>number;assertActive?:()=>Promise<void>;beforeSearch?:()=>Promise<void>}
const root='https://api.deepseek.com/v1/tools/';

/** Only public page identifiers go to Fetch; the API key goes solely to DeepSeek. */
export function publicWebUrl(value:unknown):string|null {
  if(typeof value!=='string'||value.length>1800)return null;
  try {
    const authority=/^https?:\/\/([^/?#]*)/i.exec(value)?.[1];
    if(!authority||/[@\\\s]/.test(authority))return null;
    const url=new URL(value),host=url.hostname;
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port||isIP(host.replace(/^\[|\]$/g,''))||!host.includes('.')||host.endsWith('.')||/(^|\.)(localhost|local|internal|home|lan)$/i.test(host)||/^(webvpn|vpn|sso|cas|auth|login)\./i.test(host)||/[{}]|%7b|%7d/i.test(url.href))return null;
    if([...url.searchParams.keys()].some(key=>/^(access[_-]?token|token|auth|authorization|session([_-]?id)?|cookie|api[_-]?key|key|password|secret|signature)$/i.test(key)))return null;
    url.hash='';return url.href;
  }catch{return null;}
}
async function bounded<T>(work:()=>Promise<T>,ms:number,onTimeout:()=>void):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{onTimeout();reject(Error('deadline'));},ms);})]);}
  finally{clearTimeout(timer);}
}
async function api(path:'search'|'fetch',body:unknown,key:string,request:typeof fetch,ms:number):Promise<any>{
  const controller=new AbortController();
  return bounded(async()=>{
    const response=await request(root+path,{method:'POST',redirect:'error',signal:controller.signal,headers:{authorization:`Bearer ${key}`,'content-type':'application/json',accept:'application/json'},body:JSON.stringify(body)});
    if(!response.ok){void response.body?.cancel().catch(()=>{});throw {status:response.status};}
    const reader=response.body?.getReader();if(!reader)throw Error('empty');
    const chunks:Uint8Array[]=[];let length=0;
    const abort=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',abort,{once:true});
    try{
      if(Number(response.headers.get('content-length'))>256000)throw Error('large');
      for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>256000)throw Error('large');chunks.push(part.value);}
      if(controller.signal.aborted)throw Error('deadline');
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch(error){void reader.cancel().catch(()=>{});throw error;}
    finally{controller.signal.removeEventListener('abort',abort);reader.releaseLock();}
  },ms,()=>controller.abort());
}
export async function deepseekWebSearch(query:string,key:string,options:Options={}):Promise<WebSearchResult>{
  const checkedAt=new Date((options.now||Date.now)()).toISOString();
  const result=(state:WebSearchResult['state'],message:string,sources:WebPageSource[]=[]):WebSearchResult=>({state,message,query,sources});
  if(!key)return result('unconfigured','本轮未配置 DeepSeek 检索凭据，未执行联网搜索。');
  if(!query.trim()||Array.from(query).length>128||/[\x00-\x1f\x7f]/.test(query)||/sk-[a-zA-Z0-9_-]{16,}|\b[^\s@]+@[^\s@]+\.[^\s@]+\b/.test(query))return result('failed','搜索词无效或包含不适合公开检索的内容，本轮未执行搜索。');
  if(key.length>512||/\s/.test(key))return result('unconfigured','本轮 DeepSeek 检索凭据无效。');
  const request=options.fetch||fetch;
  try{
    await options.assertActive?.();await options.beforeSearch?.();
    const data=await api('search',{query:query.trim(),count:5,need_content:false},key,request,6000);
    if(!Array.isArray(data?.results))return result('failed','检索服务返回格式异常，本轮未完成联网搜索。');
    const seen=new Set<string>(),candidates:Array<{url:string;title:string;snippet:boolean;date:string|null}>=[];
    for(const item of data.results.slice(0,20)){
      const url=publicWebUrl(item?.url);
      if(!url||seen.has(url)||typeof item?.title!=='string'||!item.title.trim())continue;
      seen.add(url);candidates.push({url,title:item.title.trim().slice(0,220),snippet:Boolean(item.snippet||item.summary),date:typeof item.date==='string'&&Number.isFinite(Date.parse(item.date))?new Date(item.date).toISOString():null});
      if(candidates.length===5)break;
    }
    const publicCandidates=await Promise.all(candidates.map(async candidate=>{
      try{
        const addresses=await bounded(()=>options.lookup?options.lookup(new URL(candidate.url).hostname):lookup(new URL(candidate.url).hostname,{family:4,all:true}),2000,()=>{});
        return addresses.length&&addresses.every(a=>publicAddress(a.address))?candidate:null;
      }catch{return null;}
    }));
    const sources=await Promise.all(publicCandidates.filter((v):v is NonNullable<typeof v>=>Boolean(v)).slice(0,3).map(async candidate=>{
      const source:WebPageSource={title:candidate.title,url:candidate.url,publishedAt:candidate.date,checkedAt,readState:candidate.snippet?'snippet_only':'unavailable'};
      await options.assertActive?.();
      try{
        const page=await api('fetch',{url:candidate.url},key,request,5000);
        if(typeof page?.content==='string'&&page.content.trim()){
          source.body=page.content.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').trim().slice(0,1600);source.readState='body';
          if(typeof page.title==='string'&&page.title.trim())source.title=page.title.trim().slice(0,220);
        }
      }catch{/* Unreadable pages remain labelled clues; summaries never become body evidence. */}
      return source;
    }));
    const read=sources.filter(s=>s.readState==='body').length;
    return result('complete',sources.length?`本轮搜索取得 ${sources.length} 条公开网页线索，读取了 ${read} 条正文摘录；仅正文用于回答依据。`:'本轮搜索未取得可用的公开网页线索；不能据此断言网上没有相关信息。',sources);
  }catch(error){
    if(error instanceof AppError||(error as {code?:unknown})?.code==='TASK_CANCELLED')throw error;
    const status=(error as {status?:number})?.status;
    return result('failed',status===402?'DeepSeek 检索服务余额不足，本轮未完成联网搜索。':status===401||status===403?'DeepSeek 检索凭据或访问权限未通过，本轮未完成联网搜索。':status===429?'DeepSeek 检索服务暂时限流，本轮未完成联网搜索。':'本轮联网搜索未完成，可能超时或服务暂时不可用；未自动重试。');
  }
}
