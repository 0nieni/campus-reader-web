import {lookup} from 'node:dns/promises';
import {AppError} from './errors';
import {publicAddress} from './model-provider';
import {websiteUrl} from './website-parser';
import {approvedSchoolUrl,readSchoolPage,type PageReader,type SchoolSource} from './school-pages';

export interface LexmountConfig {apiKey:string;projectId:string;baseUrl?:string;engine?:string}
interface Options {
 config?:()=>LexmountConfig;
 request?:typeof fetch;
 resolve?:(hostname:string)=>Promise<readonly {address:string}[]>;
 direct?:PageReader;
 timeoutMs?:number;
}
const engines=new Set(['auto','http','chrome','chrome_cdp','lightmount_lite','lightmount_dcl','lightmount_domstable']);
const MAX_JSON=4*1024*1024,MAX_HTML=1500000;
declare const Netlify:{env:{get(name:string):string|undefined}};
const env=(name:string)=>typeof Netlify!=='undefined'?Netlify.env.get(name):process.env[name];
function configuration():LexmountConfig{return{apiKey:env('LEXMOUNT_API_KEY')||'',projectId:env('LEXMOUNT_PROJECT_ID')||'',baseUrl:env('LEXMOUNT_WEBFETCH_BASE_URL'),engine:env('LEXMOUNT_WEBFETCH_ENGINE')};}
const problem=(code:string,message:string)=>new AppError(code,message);

function checkedConfig(value:LexmountConfig){
 const apiKey=value.apiKey.trim(),projectId=value.projectId.trim(),engine=value.engine||'auto';
 const invalid=()=>problem('LEXMOUNT_NOT_CONFIGURED','Lexmount 尚未正确配置，请在服务端设置项目凭据及官方区域入口。');
 if(!apiKey||apiKey.length>2048||/[\r\n]/.test(apiKey)||!/^[A-Za-z0-9_-]{1,100}$/.test(projectId)||!engines.has(engine))throw invalid();
 let endpoint:URL;try{endpoint=new URL(value.baseUrl||'https://api.lexmount.cn');}catch{throw invalid();}
 if(endpoint.protocol!=='https:'||!['api.lexmount.cn','api.lexmount.com'].includes(endpoint.hostname)||endpoint.port||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/')throw invalid();
 return{apiKey,projectId,engine,endpoint:new URL('/v1/dom/dump',endpoint).href};
}
function providerError(status:number,body:any):AppError{
 // Never surface arbitrary provider bodies, URLs or echoed credentials.
 const code=typeof body?.error==='object'?body.error?.code:body?.error;
 if(status===401)return problem('LEXMOUNT_AUTH_FAILED','Lexmount 凭据无效，请检查服务端 API Key 与项目编号。');
 if(code==='webfetch_quota_exhausted')return problem('LEXMOUNT_QUOTA_EXHAUSTED','Lexmount 网页采集额度已用完；已有资料保留，请检查服务商用量。');
 if(code==='client_ip_geo_blocked')return problem('LEXMOUNT_REGION_BLOCKED','Lexmount 区域入口与当前服务环境不兼容，请核对项目区域。');
 if(status===403)return problem('LEXMOUNT_ACCESS_DENIED','Lexmount 拒绝本次采集，请检查项目权限、区域或剩余额度。');
 if(status===429)return problem('LEXMOUNT_RATE_LIMITED','Lexmount 请求过于频繁，请稍后再试；本次没有自动重发。');
 return problem('LEXMOUNT_UNAVAILABLE','Lexmount 网页采集暂未完成，已有资料保留，请稍后重试。');
}

/** Public HTML only. Existing readers handle robots and non-HTML protocols.
 * No cookies, login state, browsing Contexts or model inputs reach Lexmount.
 * Only the final verified DOM enters the existing parsers and material store. */
export function lexmountReader(options:Options={}):PageReader{
 const config=options.config||configuration,request=options.request||fetch;
 const resolve=options.resolve||((hostname:string)=>lookup(hostname,{family:4,all:true}));
 const direct=options.direct||readSchoolPage;
 return async(value,source)=>{
  const target=approvedSchoolUrl(websiteUrl(value),source);
  if(target.pathname==='/robots.txt'||source.rawResponse)return direct(target.href,source);
  const settings=checkedConfig(config()),controller=new AbortController(),timeoutMs=options.timeoutMs||20000;
  let timer:ReturnType<typeof setTimeout>;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(problem('LEXMOUNT_TIMEOUT','Lexmount 采集超时；没有自动重发，已有资料保留。'));},timeoutMs);});
  const bounded=<T>(work:Promise<T>)=>Promise.race([work,deadline]);
  async function publicUrl(url:URL){
   let dnsTimer:ReturnType<typeof setTimeout>|undefined;
   const addresses=await bounded(Promise.race([resolve(url.hostname),new Promise<never>((_,reject)=>{dnsTimer=setTimeout(()=>reject(problem('SOURCE_UNAVAILABLE','采集来源的公网地址暂时无法解析。')),2000);})])).finally(()=>clearTimeout(dnsTimer));
   if(!addresses.length||addresses.some(row=>!publicAddress(row.address)))throw problem('SOURCE_RESTRICTED','采集来源不是允许的公网地址。');
  }
  async function readJson(response:Response){
   if(Number(response.headers.get('content-length'))>MAX_JSON)throw problem('LEXMOUNT_RESPONSE_TOO_LARGE','Lexmount 返回内容超过采集上限，请查看原站。');
   if(!response.body)throw providerError(response.status,null);
   const reader=response.body.getReader(),parts:Uint8Array[]=[];let total=0;
   try{for(;;){const chunk=await bounded(reader.read());if(chunk.done)break;total+=chunk.value.byteLength;if(total>MAX_JSON)throw problem('LEXMOUNT_RESPONSE_TOO_LARGE','Lexmount 返回内容超过采集上限，请查看原站。');parts.push(chunk.value);}}
   finally{void reader.cancel().catch(()=>{});}
   try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{if(!response.ok)throw providerError(response.status,null);throw problem('LEXMOUNT_INVALID_RESPONSE','Lexmount 返回格式无法识别，未保存为公告正文。');}
  }
  try{
   await publicUrl(target);
   const response=await bounded(request(settings.endpoint,{method:'POST',redirect:'error',signal:controller.signal,headers:{'content-type':'application/json','X-API-Key':settings.apiKey,'X-Project-Id':settings.projectId},body:JSON.stringify({url:target.href,options:{engine_preference:settings.engine,timeout_ms:Math.min(15000,timeoutMs),filter_scripts_styles:true}})}));
   const body=await readJson(response);
   if(!response.ok||body?.error)throw providerError(response.status,body);
   if(body.status_code===404)throw problem('SOURCE_NOT_FOUND','来源网页不存在或已调整。');
   if([401,403].includes(body.status_code))throw problem('SOURCE_RESTRICTED','来源网页拒绝公开读取，请使用原站允许的访问方式。');
   if(body.status_code!==200||typeof body.final_url!=='string'||typeof body.html!=='string'||!body.html.trim())throw problem('SOURCE_UNAVAILABLE','Lexmount 未取得可用网页，未将失败页面保存为正文。');
   const final=approvedSchoolUrl(websiteUrl(body.final_url),source);await publicUrl(final);
   if(Buffer.byteLength(body.html,'utf8')>MAX_HTML)throw problem('LEXMOUNT_RESPONSE_TOO_LARGE','网页超过正文采集上限，请查看原站。');
   return{url:final.href,html:body.html};
  }catch(error){if(error instanceof AppError)throw error;if(controller.signal.aborted)throw problem('LEXMOUNT_TIMEOUT','Lexmount 采集超时；没有自动重发，已有资料保留。');throw providerError(0,null);}
  finally{clearTimeout(timer!);controller.abort();}
 };
}
export const readLexmountPage=lexmountReader();
