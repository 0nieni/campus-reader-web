import cloudbase from "@cloudbase/node-sdk";
import { createGateway } from "./gateway";
import { cloudRepository } from "./cloudbase-repository";
import { aiService } from "./ai-service";
const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const repo = cloudRepository(app.database());
const gateway = createGateway(repo, { ownerUid: process.env.WEB_OWNER_UID, legacyOpenid: process.env.WEB_LEGACY_OPENID }, Date.now, { ai: aiService(app.database(), repo) });
export async function main(event: unknown) {
  try {
    const caller = app.auth().getUserInfo();
    if (!event || typeof event !== "object" || !("action" in event) || typeof event.action !== "string" || !event.action.startsWith("ai.")) return { ok: false, code: "ACTION_NOT_ALLOWED", message: "此入口仅提供 AI 阅读。" };
    return await gateway(event, { uid: caller.uid, isAnonymous: caller.isAnonymous });
  } catch { return { ok: false, code: "UNAUTHENTICATED", message: "无法验证会话，请重新登录。" }; }
}
