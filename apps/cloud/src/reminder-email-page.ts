import {randomBytes} from 'node:crypto';
import {AppError} from './errors';
import {boundedJson} from './netlify-http';
import {reminderOrigin} from './reminder-email';
export function createEmailPage(options:{production:()=>boolean;consume:(kind:string,token:string)=>Promise<unknown>}){
 return async(request:Request)=>{
  const headers={'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
  if(!options.production())return new Response('预览环境不验证邮箱或发送邮件。',{status:503,headers});
  if(new URL(request.url).origin!==reminderOrigin||new URL(request.url).search)return new Response(null,{status:400,headers});
  if(request.method==='POST'){
   if(request.headers.get('origin')!==reminderOrigin||request.headers.get('sec-fetch-site')==='cross-site')return new Response(null,{status:403,headers});
   try{
    const body=await boundedJson(request,256);if(Object.keys(body).some(k=>!['kind','token'].includes(k))||typeof body.kind!=='string'||typeof body.token!=='string')throw new AppError('VALIDATION_FAILED','链接无效。');
    await options.consume(body.kind,body.token);return Response.json({message:body.kind==='verify'?'邮箱已验证。请返回提醒中心，主动开启邮件提醒。':'邮件提醒已关闭。已被邮件服务接收的邮件可能仍会送达。'},{headers});
   }catch(error){return Response.json({message:error instanceof AppError?error.message:'暂时无法处理，请稍后重试。'},{status:400,headers});}
  }
  if(request.method!=='GET')return new Response(null,{status:405,headers});
  const nonce=randomBytes(16).toString('base64');
  // Tokens live in the URL fragment, so neither server request logs nor HTTP
  // referrers carry them. A GET never consumes a token (mail scanners are safe).
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>校园阅览室 · 邮件设置</title><body><main><h1>邮件设置</h1><p id="status">请确认是否继续当前邮件操作。</p><button id="confirm" type="button">确认</button><p><a href="/?view=reminders">返回提醒中心</a></p></main><script nonce="${nonce}">
const params=new URLSearchParams(location.hash.slice(1)),kind=params.has('verify')?'verify':'unsubscribe',token=params.get(kind),status=document.getElementById('status'),button=document.getElementById('confirm');history.replaceState(null,'',location.pathname);
if(!token||!/^[a-f0-9]{64}$/.test(token)){status.textContent='链接无效，请从提醒中心重新操作。';button.disabled=true;}else{button.textContent=kind==='verify'?'确认验证邮箱':'关闭邮件提醒';button.onclick=async()=>{button.disabled=true;try{const response=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,token})}),body=await response.json();status.textContent=body.message;if(!response.ok)button.disabled=false;}catch{status.textContent='网络连接未完成，请稍后重试。';button.disabled=false;}};}
</script></body></html>`,{headers:{...headers,'content-type':'text/html; charset=utf-8','content-security-policy':`default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`}});
 };
}
