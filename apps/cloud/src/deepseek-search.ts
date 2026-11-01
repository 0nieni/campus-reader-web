import type {AiSearchErrorCode} from '@campus/contracts';
import type {searchAnnouncements,SearchCandidate} from './announcement-search';
import {publicSearchSource,readPublicSearchPage} from './public-search-page';
import {approvedSchoolUrl,readSchoolPage,type PageReader} from './school-pages';
import {resolveSearchRedirects} from './search-redirects';
import {AppError} from './errors';

type SearchResult=Awaited<ReturnType<typeof searchAnnouncements>>;
type SearchSchool=Parameters<typeof searchAnnouncements>[0];
type Options={fetch?:typeof fetch;apiKey?:string};
const root='https://api.deepseek.com/v1/tools/';
const messages:Record<AiSearchErrorCode,string>={
  unconfigured:'DeepSeek 联网搜索尚未配置，请联系网站管理员检查后台官方 DeepSeek Key。已有公告仍可使用。',
  authorization:'DeepSeek 搜索授权异常，请管理员检查官方 Key 与接口权限。已有公告仍可使用。',
  quota:'DeepSeek 搜索服务余额不足，请管理员检查账户余额。已有公告仍可使用。',
  rate_limited:'DeepSeek 搜索请求过于频繁，请稍后重试。已有公告仍可使用。',
  timeout:'本次 DeepSeek 搜索超时，请稍后重试。已有公告仍可使用。',
  network:'DeepSeek 搜索连接失败，请稍后重试。已有公告仍可使用。',
  provider:'DeepSeek 搜索服务暂时异常，请稍后重试。已有公告仍可使用。',
  invalid_response:'DeepSeek 搜索响应或查询主题无法安全使用，本轮未完成搜索。已有公告仍可使用。',
  invalid_scope:'搜索范围无法确认，未发送搜索请求。已有公告仍可使用。',
};
class ToolError extends Error {constructor(readonly code:AiSearchErrorCode){super(messages[code]);}}
/** A relay/OpenAI key must never be forwarded to DeepSeek. User model profiles are unrelated. */
export function deepseekSearchKey(env:Record<string,string|undefined>=process.env):string|null {
  const key=env.AI_CHAT_API_KEY;
  if(!key||key.length>512||/[^\x21-\x7e]/.test(key))return null;
  try{
    const url=new URL(env.AI_CHAT_BASE_URL||'https://api.deepseek.com');
    if(url.protocol!=='https:'||url.hostname!=='api.deepseek.com'||url.port||url.username||url.password||url.search||url.hash||!['','/','/v1','/v1/','/chat/completions','/chat/completions/','/v1/chat/completions','/v1/chat/completions/'].includes(url.pathname))return null;
    return key;
  }catch{return null;}
}
export const deepseekSearchConfigured=()=>Boolean(deepseekSearchKey());

/** Fixed endpoint, no redirects, bounded JSON and a deadline including the streamed body. */
async function tool(path:'search'|'fetch',body:unknown,key:string,request:typeof fetch,timeoutMs=8000):Promise<any>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([(async()=>{
    let response:Response;
    try{response=await request(root+path,{method:'POST',redirect:'error',signal:controller.signal,headers:{authorization:`Bearer ${key}`,'content-type':'application/json',accept:'application/json'},body:JSON.stringify(body)});}
    catch{throw new ToolError(controller.signal.aborted?'timeout':'network');}
    if(!response.ok){void response.body?.cancel().catch(()=>{});throw new ToolError([401,403].includes(response.status)?'authorization':response.status===402?'quota':response.status===429?'rate_limited':'provider');}
    const reader=response.body?.getReader();if(!reader)throw new ToolError('invalid_response');
    const chunks:Uint8Array[]=[];let size=0;
    const abort=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',abort,{once:true});
    try{
      if(Number(response.headers.get('content-length'))>512*1024)throw new ToolError('invalid_response');
      for(;;){const value=await reader.read();if(value.done)break;size+=value.value.byteLength;if(size>512*1024)throw new ToolError('invalid_response');chunks.push(value.value);}
      if(controller.signal.aborted)throw new ToolError('timeout');
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch(error){void reader.cancel().catch(()=>{});throw error instanceof ToolError?error:new ToolError('invalid_response');}
    finally{controller.signal.removeEventListener('abort',abort);reader.releaseLock();}
  })(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ToolError('timeout'));},timeoutMs);})]);}
  finally{clearTimeout(timer);}
}
function safeUrl(value:unknown):string|null {
  if(typeof value!=='string')return null;
  try{
    const source=publicSearchSource(value),url=approvedSchoolUrl(value,source);
    if([...url.searchParams.keys()].some(k=>/^(token|access[_-]?token|api[_-]?key|key|signature|password|secret|cookie|session([_-]?id)?)$/i.test(k)))return null;
    return url.href;
  }catch{return null;}
}
export async function deepseekSearchPublicWeb(school:SearchSchool,query:string,options:Options={}):Promise<SearchResult>{
  const key=options.apiKey??deepseekSearchKey();
  const failed=(code:AiSearchErrorCode):SearchResult=>({state:code==='unconfigured'?'unconfigured':'failed',code,message:messages[code],candidates:[]});
  if(!key||key.length>512||/[^\x21-\x7e]/.test(key))return failed('unconfigured');
  const subject=query.trim().replace(/本校|我们学校/g,()=>school.name.trim());
  if(!subject||/[\x00-\x1f\x7f]|sk-[\w-]{16,}|\b[^\s@]+@[^\s@]+\.[^\s@]+\b/.test(subject))return failed('invalid_response');
  try{
    const data=await tool('search',{query:Array.from(subject).slice(0,128).join(''),count:5,need_content:false},key,options.fetch||fetch);
    if(!Array.isArray(data?.results))return failed('invalid_response');
    const candidates:SearchCandidate[]=[],seen=new Set<string>();
    for(const item of data.results.slice(0,50)){
      const url=safeUrl(item?.url);
      if(!url||seen.has(url)||typeof item?.title!=='string'||!item.title.trim())continue;
      seen.add(url);candidates.push({url,title:item.title.trim().slice(0,220),snippet:typeof item.snippet==='string'?item.snippet.trim().slice(0,2000):''});
      if(candidates.length===5)break;
    }
    return{state:'complete',message:candidates.length?'本次 DeepSeek 全网搜索已完成；候选摘要只作线索，正文仍需核验。':'本次 DeepSeek 全网搜索已完成，未取得可用的公开网页线索。已有资料仍可使用。',candidates};
  }catch(error){return failed(error instanceof ToolError?error.code:'invalid_response');}
}

type ReaderOptions=Options&{robotsReader?:PageReader;redirectOptions?:Parameters<typeof resolveSearchRedirects>[2];pause?:(ms:number)=>Promise<void>;deadline?:number};
const escape=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
/** Keep the existing robots/exact-host checks. Fetch content is escaped data, never HTML instructions. */
export const readDeepseekPublicPage: (value:string,options?:ReaderOptions)=>ReturnType<PageReader> = async(value,options={})=>{
  const deadline=options.deadline??Date.now()+24000;
  const check=()=>{if(Date.now()>=deadline)throw new AppError('SOURCE_UNAVAILABLE','本轮网页读取已到时限，未继续发起请求。');};check();
  const key=options.apiKey??deepseekSearchKey();if(!key)throw new AppError('SOURCE_UNAVAILABLE',messages.unconfigured);
  const reader:PageReader=async(target,source)=>{
    check();
    if(new URL(target).pathname==='/robots.txt')return(options.robotsReader||readSchoolPage)(target,source);
    const url=safeUrl(target);if(!url)throw new AppError('SOURCE_RESTRICTED','只能读取安全的公开网页。');
    approvedSchoolUrl(url,source);
    const finalUrl=await resolveSearchRedirects(url,source,options.redirectOptions);
    check();const page=await tool('fetch',{url:finalUrl},key,options.fetch||fetch,Math.min(8000,deadline-Date.now()));
    if(typeof page?.content!=='string'||page.content.trim().length<30||page.content.length>60000)throw new AppError('NO_MATERIAL','DeepSeek 未取得可用的网页正文。');
    // Fetch exposes no final URL; retain the independently verified redirect destination.
    return{url:finalUrl,html:`<main><article><p>${escape(page.content)}</p></article></main>`};
  };
  return readPublicSearchPage(value,reader,options.pause);
};
const hostReads=new Map<string,Promise<Awaited<ReturnType<PageReader>>>>();
export const deepseekPublicSearchReader:PageReader=async(value,source)=>{
  const host=new URL(publicSearchSource(value).homepage).host,previous=hostReads.get(host);
  const pending=(previous?previous.catch(()=>undefined):Promise.resolve()).then(()=>readDeepseekPublicPage(value,{deadline:source.readDeadline}));hostReads.set(host,pending);
  try{return await pending;}finally{if(hostReads.get(host)===pending)hostReads.delete(host);}
};
