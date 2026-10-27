import type { AuthSession, GatewayResult, AnonymousState } from '@campus/contracts';
import type { Transport } from './transport';
import {disablePush} from './browser-push';
import { ClientError } from './errors';
import { handleAuthCallback, hydrateSession, onAuthChange, recoverPassword, logout } from '@netlify/identity';
const listeners = new Set<(session: AuthSession | null) => void>();
const legacyWorkspace=()=>new URLSearchParams(location.search).get('workspace')==='account';
let startingGuest:Promise<AnonymousState>|undefined;
function guestState(){
 if(!startingGuest){startingGuest=request<AnonymousState>('/.netlify/functions/guest',{op:'session'});void startingGuest.finally(()=>{startingGuest=undefined;}).catch(()=>{});}
 return startingGuest;
}
function notify(session: AuthSession | null) { for (const listener of listeners) listener(session); }
function confirmationError(caught:unknown):ClientError {
  let error=caught,status:number|undefined;
  for(let depth=0;depth<4&&error&&typeof error==='object';depth++){
    const candidate=error as {status?:unknown;cause?:unknown};
    if(typeof candidate.status==='number'&&Number.isInteger(candidate.status)){status=candidate.status;break;}
    error=candidate.cause;
  }
  if(status===400||status===404||status===410||status===422)return new ClientError('CONFIRMATION_INVALID','邮件确认链接无效、已过期或已使用。请返回登录；若仍无法登录，请联系站点管理员重新发送确认邮件。');
  if(status===429)return new ClientError('CONFIRMATION_RATE_LIMITED','邮箱验证请求过于频繁，请稍后再试。');
  if(status!==undefined&&status>=500)return new ClientError('CONFIRMATION_UNAVAILABLE','邮箱验证服务暂时不可用，请稍后再试，或联系站点管理员。');
  if(status===401||status===403)return new ClientError('CONFIRMATION_REJECTED','邮箱验证未通过，请返回登录；若仍无法登录，请联系站点管理员。');
  return new ClientError('CONFIRMATION_CONNECTION_FAILED','邮箱验证请求未能完成，请检查网络或浏览器限制后再试。链接可能已被处理，可先返回登录确认。');
}
async function request<T>(url: string, body?: unknown): Promise<T> {
  let result: GatewayResult<T>;
  try {
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(55000), ...(body === undefined ? {} : { headers: { 'content-type': 'application/json',...(url==='/.netlify/functions/api'&&legacyWorkspace()?{'x-campus-workspace':'account'}:{}) }, body: JSON.stringify(body) }) });
    result = await response.json();
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') throw new Error('Invalid envelope');
  } catch {
    const ai = body && typeof body === 'object' && 'action' in body && typeof body.action === 'string' && body.action.startsWith('ai.');
    throw new ClientError('CONNECTION_FAILED', ai ? 'AI 请求未完成，请先刷新任务状态，勿重复创建任务。' : '本站服务暂时无法连接，请检查网络后重试。');
  }
  if (!result.ok) {
    if (['UNAUTHENTICATED', 'FORBIDDEN'].includes(result.code)) notify(null);
    // Server exposes a bounded public envelope; raw platform responses are never echoed.
    throw new ClientError(result.code, result.message);
  }
  return result.data;
}
export const netlifyTransport: Transport = {
  anonymous:{state:guestState,createTransfer:()=>request('/.netlify/functions/guest',{op:'transfer.create'}),cancelTransfer:()=>request('/.netlify/functions/guest',{op:'transfer.cancel'}),importTransfer:code=>request('/.netlify/functions/guest',{op:'transfer.import',code})},
  async restore() { if(legacyWorkspace()){await hydrateSession();return request<AuthSession|null>('/.netlify/functions/auth');}await hydrateSession().catch(()=>null);return(await guestState()).identity; },
  async signIn(email, password) { const value = await request<AuthSession>('/.netlify/functions/auth?op=login', { email: email.trim(), password }); await hydrateSession(); notify(value); return value; },
  signUp: (email, password) => request('/.netlify/functions/auth?op=signup', { email: email.trim(), password }),
  async requestPasswordRecovery() { await request('/.netlify/functions/auth?op=password-recovery', {}); },
  async recoverPassword(token, password) {
    let recoveredId: string;
    try { recoveredId = (await recoverPassword(token, password)).id; }
    catch { await logout().catch(()=>{}); notify(null); throw new ClientError('RECOVERY_FAILED', '密码重置未完成，链接可能已失效。请重新申请重置邮件后再试。'); }
    let value: AuthSession | null;
    try { value = await request<AuthSession | null>('/.netlify/functions/auth'); }
    catch { await logout().catch(()=>{}); notify(null); throw new ClientError('RECOVERY_VERIFICATION_FAILED', '新密码已提交，但登录状态未能核验。请返回登录，使用新密码重新登录。'); }
    if (!value || value.uid !== recoveredId) { await logout().catch(()=>{}); notify(null); throw new ClientError('UNAUTHENTICATED', '密码已重置，请使用新密码登录。'); }
    notify(value); return value;
  },
  async confirmEmail(token) {
    if(!token||new URLSearchParams(location.hash.slice(1)).get('confirmation_token')!==token)throw new ClientError('CONFIRMATION_INVALID','邮件确认链接无效，请重新打开确认邮件中的链接。');
    let confirmedId:string;
    try {
      // Unlike confirmEmail(), the SDK callback also synchronizes the cookies
      // that our same-origin Functions need to recognize the verified account.
      const result=await handleAuthCallback();
      if(!result||result.type!=='confirmation'||!result.user?.id)throw Error('Unexpected confirmation result');
      confirmedId=result.user.id;
    }
    catch(caught){await logout().catch(()=>{});notify(null);throw confirmationError(caught);}
    let value:AuthSession|null;
    try{value=await request<AuthSession|null>('/.netlify/functions/auth');}
    catch{await logout().catch(()=>{});notify(null);throw new ClientError('CONFIRMATION_SESSION_FAILED','邮箱确认后的登录状态未能核验，请返回登录，使用注册时设置的密码登录。');}
    if(!value||value.uid!==confirmedId){await logout().catch(()=>{});notify(null);throw new ClientError('CONFIRMATION_SESSION_FAILED','邮箱已确认，请返回登录，使用注册时设置的密码登录。');}
    notify(value); return value;
  },
  async signOut() { if(legacyWorkspace())await Promise.race([disablePush(netlifyTransport).catch(()=>{}),new Promise(resolve=>setTimeout(resolve,2500))]); await request('/.netlify/functions/auth?op=logout', {}); notify(null); },
  onSessionChange(listener) {
    listeners.add(listener);
    const stop = onAuthChange((_event, user) => { if (!user) listener(null); else listener({ uid: user.id, username: user.email || null }); });
    return () => { listeners.delete(listener); stop(); };
  },
  call: (action, input) => request('/.netlify/functions/api', { action, input }),
};
