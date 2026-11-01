import type { AuthSession, GatewayResult } from '@campus/contracts';
import { AppError } from './errors';
import { normalizedEmail, requireSiteUser } from './site-access';
export interface NetlifyUser { id: string; email: string }
export interface SiteAuth {
  user(): Promise<NetlifyUser | null>;
  login(email: string, password: string): Promise<NetlifyUser>;
  logout(): Promise<void>;
  signup?(email: string, password: string): Promise<NetlifyUser & { confirmedAt?: string }>;
  requestPasswordRecovery?(email: string): Promise<void>;
}
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
export async function boundedJson(request: Request, max = 12000): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new AppError('VALIDATION_FAILED', '请求格式应为 JSON。');
  const reader = request.body?.getReader(); let text = '', bytes = 0;
  if (!reader) throw new AppError('VALIDATION_FAILED', '请求参数为空。');
  const decoder = new TextDecoder();
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > max) { await reader.cancel(); throw new AppError('VALIDATION_FAILED', '请求参数过长。'); } text += decoder.decode(part.value, { stream: true }); }
    text += decoder.decode();
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not-object');
    return value;
  } catch (error) { if (error instanceof AppError) throw error; throw new AppError('VALIDATION_FAILED', '请求参数无效。'); }
}
export function sameOrigin(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new AppError('FORBIDDEN', '请从本站页面提交操作。');
}
const session = (user: NetlifyUser): AuthSession => ({ uid: user.id, username: user.email });
function failed(error: unknown) {
  if (error instanceof AppError) return response({ ok: false, code: error.code, message: error.message }, error.code === 'UNAUTHENTICATED' ? 401 : error.code === 'FORBIDDEN' ? 403 : error.code === 'VALIDATION_FAILED' ? 400 : 503);
  return response({ ok: false, code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请检查本站认证与数据库配置。' }, 503);
}
export function createSiteAuth(auth: SiteAuth, email: () => string | undefined) {
  return async (request: Request): Promise<Response> => {
    try {
      const op = new URL(request.url).searchParams.get('op') || 'session';
      if (op === 'session' && request.method === 'GET') {
        const user = await auth.user(); return response({ ok: true, data: user ? session(requireSiteUser(user, email())) : null });
      }
      if (request.method !== 'POST' || !['login', 'logout', 'signup', 'password-recovery'].includes(op)) return response({ ok: false, code: 'ACTION_NOT_ALLOWED', message: '请求方式无效。' }, 405);
      sameOrigin(request);
      if (op === 'logout') { await auth.logout(); return response({ ok: true, data: null }); }
      if (op === 'password-recovery') {
        const current = await auth.user();
        if (!current) throw new AppError('UNAUTHENTICATED', '请先登录本人账号。');
        const own = requireSiteUser(current, email());
        const body = await boundedJson(request, 1000);
        if (Object.keys(body).length) throw new AppError('VALIDATION_FAILED', '重置邮件仅发送到当前账号邮箱。');
        if (!auth.requestPasswordRecovery) throw new AppError('RECOVERY_UNAVAILABLE', '本站密码重置暂未启用。');
        try { await auth.requestPasswordRecovery(own.email); }
        catch { throw new AppError('RECOVERY_UNAVAILABLE', '重置邮件未能发送，请稍后再试，或联系站点管理员。'); }
        return response({ ok: true, data: null });
      }
      const body = await boundedJson(request, 2000);
      if (Object.keys(body).some(key => !['email','password'].includes(key)) || typeof body.email !== 'string' || typeof body.password !== 'string' || body.email.length > 254 || !body.password || body.password.length > 256) throw new AppError('VALIDATION_FAILED', '请输入有效的邮箱和密码。');
      if (!normalizedEmail(email())) throw new AppError('OWNER_NOT_CONFIGURED', '本站尚未配置初始工作区账号。');
      if (op === 'signup') {
        if (!auth.signup) throw new AppError('REGISTRATION_UNAVAILABLE', '本站注册尚未启用，请稍后再试。');
        const submittedEmail = normalizedEmail(body.email);
        if (!submittedEmail || body.password.length < 12) throw new AppError('VALIDATION_FAILED', '请输入有效邮箱，并设置12至256位密码。');
        try {
          const user = await auth.signup(submittedEmail, body.password);
          // The product requires email verification. Do not adopt an unexpected
          // autoconfirmed session or return identity/provider payloads to the UI.
          if (user.confirmedAt) {
            await auth.logout();
            throw new AppError('REGISTRATION_UNAVAILABLE', '本站邮箱验证注册暂不可用，请联系站点管理员后再试。');
          }
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError('REGISTRATION_UNAVAILABLE', '注册未能完成。若已注册，请登录或查看此前的确认邮件；否则请稍后重试。');
        }
        return response({ ok: true, data: { verificationRequired: true } });
      }
      if (!normalizedEmail(body.email)) throw new AppError('UNAUTHENTICATED', '邮箱或密码不正确，或邮箱尚未完成验证。');
      let user: NetlifyUser;
      try { user = await auth.login(body.email.trim(), body.password); }
      catch { throw new AppError('UNAUTHENTICATED', '邮箱或密码不正确，或邮箱尚未完成验证。'); }
      try {
        requireSiteUser(user, email());
        if (normalizedEmail(user.email) !== normalizedEmail(body.email)) throw new AppError('UNAUTHENTICATED', '登录会话与提交的账号不一致，请重新登录。');
        return response({ ok: true, data: session(user) });
      }
      catch (error) { await auth.logout(); throw error; }
    } catch (error) { return failed(error); }
  };
}
export function createSiteApi(options: { auth: Pick<SiteAuth, 'user'>; ownerEmail(): string | undefined; gateway(event: unknown, user: NetlifyUser): Promise<GatewayResult<unknown>> }) {
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'POST') return response({ ok: false, code: 'ACTION_NOT_ALLOWED', message: '请使用 POST 请求。' }, 405);
      sameOrigin(request);
      const current = await options.auth.user();
      if (!current) throw new AppError('UNAUTHENTICATED','请先登录本人账号。');
      const user = requireSiteUser(current, options.ownerEmail());
      const body = await boundedJson(request);
      if (body.action === 'ai.relay') throw new AppError('FORBIDDEN', '本站不提供外部 AI 中继操作。');
      const result = await options.gateway(body, user);
      return response(result, result.ok ? 200 : result.code === 'UNAUTHENTICATED' ? 401 : result.code === 'FORBIDDEN' ? 403 : 400);
    } catch (error) { return failed(error); }
  };
}
