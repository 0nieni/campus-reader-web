import { getSettings, getUser, login, logout, signup, requestPasswordRecovery, verifyRequestOrigin } from '@netlify/identity';
import { AppError } from '../../apps/cloud/src/errors';
import { createSiteAuth } from '../../apps/cloud/src/netlify-http';
declare const Netlify: { env: { get(name: string): string | undefined } };
const handler = createSiteAuth({
  async user() { const user = await getUser(); return user?.email ? { id: user.id, email: user.email } : null; },
  async login(email, password) { const user = await login(email, password); return { id: user.id, email: user.email || '' }; },
  logout,
  requestPasswordRecovery,
  async signup(email, password) {
    const settings = await getSettings();
    if (settings.disableSignup || settings.autoconfirm !== false) throw new AppError('REGISTRATION_UNAVAILABLE', '本站邮箱验证注册尚未开放，请稍后再试。');
    const user = await signup(email, password);
    return { id: user.id, email: user.email || '', ...(user.confirmedAt ? { confirmedAt: user.confirmedAt } : {}) };
  },
}, () => Netlify.env.get('NETLIFY_OWNER_EMAIL'));
export default async (request: Request) => {
  if (request.method === 'POST') {
    try { verifyRequestOrigin(request); }
    catch { return Response.json({ ok: false, code: 'FORBIDDEN', message: '请从本站页面提交操作。' }, { status: 403, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } }); }
  }
  return handler(request);
};
