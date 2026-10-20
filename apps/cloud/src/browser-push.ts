import {createHash,createPublicKey} from 'node:crypto';
import webpush from 'web-push';
import {request} from 'node:https';
import type {BrowserPushSubscription} from '@campus/contracts';
import {reject} from './errors';
export interface PushConfig { publicKey:string; privateKey:string; subject:string }
export const endpointHash=(endpoint:string)=>createHash('sha256').update(endpoint).digest('hex');
export function checkedSubscription(value:unknown):BrowserPushSubscription {
  const input=value as BrowserPushSubscription;
  if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['endpoint','keys'].includes(k)))reject('VALIDATION_FAILED','推送订阅格式无效。');
  let endpoint:URL;try{endpoint=new URL(input.endpoint);}catch{reject('VALIDATION_FAILED','推送服务地址无效。');}
  // Only browser-vendor HTTPS endpoints. No arbitrary URL, custom port, redirect,
  // credentials or localhost: prevents turning subscription/test into SSRF.
  const allowed=['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'];
  if(typeof input.endpoint!=='string'||input.endpoint.length>2048||endpoint.protocol!=='https:'||endpoint.port||endpoint.username||endpoint.password||endpoint.hash||!allowed.some(host=>endpoint.hostname===host||(host==='web.push.apple.com'&&endpoint.hostname.endsWith('.'+host)))&&!endpoint.hostname.endsWith('.notify.windows.com'))reject('VALIDATION_FAILED','此推送服务暂不支持，请使用 Chrome、Edge、Firefox 或 Safari。');
  if(!input.keys||Object.keys(input.keys).some(k=>!['auth','p256dh'].includes(k))||!/^[-\w]{22}$/.test(input.keys.auth)||!/^[-\w]{87}$/.test(input.keys.p256dh))reject('VALIDATION_FAILED','推送加密参数无效，请重新授权。');
  const key=Buffer.from(input.keys.p256dh,'base64url');
  if(key[0]!==4)reject('VALIDATION_FAILED','推送公钥无效。');
  try{createPublicKey({key:{kty:'EC',crv:'P-256',x:key.subarray(1,33).toString('base64url'),y:key.subarray(33).toString('base64url')},format:'jwk'});}catch{reject('VALIDATION_FAILED','推送公钥无效。');}
  return{endpoint:endpoint.href,keys:{p256dh:input.keys.p256dh,auth:input.keys.auth}};
}
export function createPushRequest(subscription:BrowserPushSubscription,config:PushConfig,tag:string){
  return webpush.generateRequestDetails(checkedSubscription(subscription),JSON.stringify({title:'校园阅览室',body:'你有新的提醒，请登录提醒中心查看。',tag,url:'/?view=reminders'}),{vapidDetails:config,TTL:86400,urgency:'normal',topic:tag.slice(0,32)});
}
export async function sendBrowserPush(subscription:BrowserPushSubscription,config:PushConfig,tag:string){
  const details=createPushRequest(subscription,config,tag);
  // An absolute deadline, not just a socket-idle timeout. HTTPS does not follow
  // redirects; errors contain only a status code, never an endpoint or key.
  await new Promise<void>((resolve,reject)=>{
    const req=request(details.endpoint,{method:details.method,headers:details.headers,signal:AbortSignal.timeout(3500)},res=>{
      res.resume();
      if(res.statusCode&&res.statusCode>=200&&res.statusCode<300)resolve();
      else reject(Object.assign(new Error('Push request rejected'),{statusCode:res.statusCode}));
    });
    req.on('error',()=>reject(new Error('Push request incomplete')));req.end(details.body);
  });
}
