import type { AuthSession, GatewayResult } from '@campus/contracts';
import type { Transport } from './transport';
import {disablePush} from './browser-push';
import { ClientError } from './errors';
import { confirmEmail, hydrateSession, onAuthChange, recoverPassword, logout } from '@netlify/identity';
const listeners = new Set<(session: AuthSession | null) => void>();
function notify(session: AuthSession | null) { for (const listener of listeners) listener(session); }
async function request<T>(url: string, body?: unknown): Promise<T> {
  let result: GatewayResult<T>;
  try {
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(55000), ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
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
  async restore() { await hydrateSession(); return request<AuthSession | null>('/.netlify/functions/auth'); },
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
    try { await confirmEmail(token); }
    catch { throw new ClientError('CONFIRMATION_FAILED', '邮箱验证未完成，链接可能已过期或已使用。请返回登录；若仍未验证，请联系站点管理员重新发送确认邮件。'); }
    const value = await request<AuthSession | null>('/.netlify/functions/auth');
    if (!value) throw new ClientError('UNAUTHENTICATED', '邮箱已确认，请使用刚设置的密码登录。');
    notify(value); return value;
  },
  async signOut() { await Promise.race([disablePush(netlifyTransport).catch(()=>{}),new Promise(resolve=>setTimeout(resolve,2500))]); await request('/.netlify/functions/auth?op=logout', {}); notify(null); },
  onSessionChange(listener) {
    listeners.add(listener);
    const stop = onAuthChange((_event, user) => { if (!user) listener(null); else listener({ uid: user.id, username: user.email || null }); });
    return () => { listeners.delete(listener); stop(); };
  },
  call: (action, input) => request('/.netlify/functions/api', { action, input }),
};
