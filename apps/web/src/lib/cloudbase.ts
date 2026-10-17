import cloudbase from "@cloudbase/js-sdk/app";
import { registerAuth } from "@cloudbase/js-sdk/auth";
import { registerFunctions } from "@cloudbase/js-sdk/functions";
import type {
  AuthSession,
  GatewayAction,
  GatewayActions,
  GatewayResult,
} from "@campus/contracts";
import type { Transport } from "./transport";
import { ClientError } from "./errors";

registerAuth(cloudbase);
registerFunctions(cloudbase);

const config = {
  env: import.meta.env.VITE_CLOUDBASE_ENV_ID as string | undefined,
  region: import.meta.env.VITE_CLOUDBASE_REGION as string | undefined,
  publishableKey: import.meta.env.VITE_CLOUDBASE_PUBLISHABLE_KEY as
    | string
    | undefined,
  passwordReady: import.meta.env.VITE_CLOUDBASE_PASSWORD_READY === "true",
};
export const regionNeedsVerification = import.meta.env.VITE_CLOUDBASE_REGION_VERIFIED !== "true";
export const setupIssues = [
  ...(!config.env ? ["填写 CloudBase 环境 ID"] : []),
  ...(!config.region ? ["确认并填写环境地域"] : []),
  ...(!config.passwordReady ? ["核实用户名密码登录与本人账号配置"] : []),
];
let instance: ReturnType<typeof cloudbase.init> | undefined;
function app() {
  if (
    !config.env ||
    !config.region ||
    !config.passwordReady
  ) {
    throw new ClientError(
      "SETUP_REQUIRED",
      "网页登录尚未配置，请先完成接入设置。",
    );
  }
  return (instance ??= cloudbase.init({
    env: config.env,
    region: config.region,
      ...(config.publishableKey ? { accessKey: config.publishableKey } : {}),
    auth: { detectSessionInUrl: false },
    persistence: "session",
    timeout: 70000,
  }));
}
type SessionData = Awaited<
  ReturnType<ReturnType<typeof cloudbase.init>["auth"]["getSession"]>
>["data"];
function sessionOf(data: SessionData): AuthSession | null {
  const user = data.session?.user;
  if (!data.session || !user || user.is_anonymous || typeof user.id !== 'string' || !user.id) return null;
  return { uid: user.id, username: null };
}
type Operation = 'session' | 'login' | 'gateway';
function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return typeof error.code === 'string' || typeof error.code === 'number' ? String(error.code).toLowerCase() : '';
}
function sdkError(error: unknown, operation: Operation): ClientError {
  if (error instanceof ClientError) return error;
  const code = errorCode(error);
  if (operation === 'login') {
    if (code === 'password_not_set') return new ClientError('PASSWORD_NOT_SET', '这个用户尚未设置密码，请在云开发用户管理中设置后再登录。');
    if (['provider_not_enabled', 'login_method_disabled', 'login_type_disabled'].includes(code)) return new ClientError('LOGIN_DISABLED', '云端尚未启用此账号的密码登录，请检查登录方式配置。');
    if (/invalid.*(credential|password)|^not_found$|user_not_found|wrong_password|password.*error/i.test(code)) return new ClientError('LOGIN_FAILED', '账号或密码不正确，请检查后重试。');
  }
  if (operation === 'gateway' && /function.*not.*found|function_not_exist|invalid_function_name/i.test(code)) return new ClientError('GATEWAY_NOT_DEPLOYED', '云账号登录已完成，但工作区网关 webGateway 尚未部署。');
  if (/unauthenticated|expired|unauthorized|^401$|not_logged_in/i.test(code)) return new ClientError('UNAUTHENTICATED', '当前登录无效，请重新登录。');
  return new ClientError('CLOUD_UNAVAILABLE', operation === 'session'
    ? '暂时无法检查登录状态，请检查网络或云端认证设置后重试。'
    : operation === 'login'
      ? '登录请求未完成，请检查网络、环境地域和允许访问来源后重试。'
      : '账号已登录，但工作区连接失败，请检查网关部署和允许访问来源后重试。');
}
export const cloudTransport: Transport = {
  async restore() {
    try {
      const { data, error } = await app().auth.getSession();
      // SDK 3.10.2 returns this local error when there is no saved session.
      // It is not evidence of a network, password, or gateway failure.
      if (error && ['unauthenticated', 'not_logged_in'].includes(errorCode(error))) return null;
      if (error) throw sdkError(error, 'session');
      return sessionOf(data);
    } catch (error) {
      if (['unauthenticated', 'not_logged_in'].includes(errorCode(error))) return null;
      throw sdkError(error, 'session');
    }
  },
  async signIn(username, password) {
    if (!username.trim() || !password)
      throw new ClientError("VALIDATION_FAILED", "请输入用户名和密码。");
    try {
      const { data, error } = await app().auth.signInWithPassword({ username: username.trim(), password });
      if (error) throw sdkError(error, 'login');
      const session = sessionOf(data);
      if (!session) throw new ClientError('UNAUTHENTICATED', '未取得有效登录会话，请检查账号配置。');
      return session;
    } catch (error) { throw sdkError(error, 'login'); }
  },
  async signOut() {
    if (!instance) return;
    // Installed 3.10.2 resolves SignoutResponse (or void) and rejects on error.
    await instance.auth.signOut();
  },
  onSessionChange(listener) {
    if (setupIssues.length) return () => {};
    const { data } = app().auth.onAuthStateChange((event, session) => {
      const current = sessionOf({ session, user: session?.user });
      // A normal initial empty session is not an expiration event.
      if (event === 'INITIAL_SESSION' && !current) return;
      listener(current);
    });
    return () => data.subscription.unsubscribe();
  },
  async call<A extends GatewayAction>(
    action: A,
    input: GatewayActions[A]["input"],
  ) {
    if (!(await this.restore()))
      throw new ClientError("UNAUTHENTICATED", "请先使用本人账号登录。");
    try {
      let result: unknown;
      if (['ai.step', 'ai.status'].includes(action) && import.meta.env.VITE_AI_EXECUTOR === 'netlify') {
        const { data, error } = await app().auth.getSession();
        const token = data.session?.access_token;
        if (error || !sessionOf(data) || !token) throw new ClientError('UNAUTHENTICATED', '请重新登录后使用 AI。');
        const response = await fetch('/.netlify/functions/ai', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(55000), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ action, input }) });
        result = await response.json();
      } else {
        const response = await app().callFunction({
        name: action.startsWith("ai.") ? (import.meta.env.VITE_CLOUDBASE_AI_FUNCTION || "webAi") : (import.meta.env.VITE_CLOUDBASE_FUNCTION || "webGateway"),
        data: { action, input },
        });
        result = response.result;
      }
      if (!result || typeof result !== "object" || !("ok" in result))
        throw new ClientError(
          "INVALID_RESPONSE",
          "云端返回格式不匹配，请检查网关版本。",
        );
      const envelope = result as GatewayResult<GatewayActions[A]["output"]>;
      if (!envelope.ok && action.startsWith("ai.") && envelope.code === 'OWNER_NOT_CONFIGURED') throw new ClientError('OWNER_NOT_CONFIGURED', 'AI 专用函数 webAi 尚未配置 WEB_OWNER_UID，请复制已验证的网关配置。');
      if (!envelope.ok) throw new ClientError(envelope.code, envelope.message);
      return envelope.data;
    } catch (error) {
      if (error instanceof ClientError) throw error;
      if (action.startsWith("ai.")) {
        if (/function.*not.*found|function_not_exist|invalid_function_name/i.test(errorCode(error))) throw new ClientError('AI_WORKER_REQUIRED', 'AI 专用函数 webAi 尚未部署。');
        if (!/unauthenticated|expired|unauthorized|^401$|not_logged_in/i.test(errorCode(error))) throw new ClientError('AI_CONNECTION_FAILED', 'AI 请求未完成，已暂停后续调用。请刷新任务状态，勿重复创建同一任务。');
      }
      throw sdkError(error, 'gateway');
    }
  },
};
