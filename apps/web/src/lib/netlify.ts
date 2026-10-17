import type { AuthSession, GatewayResult } from '@campus/contracts';
import type { Transport } from './transport';
import { ClientError } from './errors';
import { hydrateSession, onAuthChange } from '@netlify/identity';
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
  async signOut() { await request('/.netlify/functions/auth?op=logout', {}); notify(null); },
  onSessionChange(listener) {
    listeners.add(listener);
    const stop = onAuthChange((_event, user) => { if (!user) listener(null); else listener({ uid: user.id, username: user.email || null }); });
    return () => { listeners.delete(listener); stop(); };
  },
  call: (action, input) => request('/.netlify/functions/api', { action, input }),
};
