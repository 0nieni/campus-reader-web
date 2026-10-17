import cloudbase from "@cloudbase/node-sdk";
import { createGateway } from "./gateway";
import { cloudRepository } from "./cloudbase-repository";
import { bookmarksService } from "./bookmarks";

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const repo = cloudRepository(app.database());
const gateway = createGateway(repo, {
  ownerUid: process.env.WEB_OWNER_UID,
  legacyOpenid: process.env.WEB_LEGACY_OPENID,
}, Date.now, { bookmarks: bookmarksService(app.database(), repo) });

/** SDK invocation only. Do not expose as an unauthenticated HTTP route. */
export async function main(event: unknown) {
  try {
    const caller = app.auth().getUserInfo();
    return await gateway(event, {
      uid: caller.uid,
      isAnonymous: caller.isAnonymous,
    });
  } catch {
    return {
      ok: false,
      code: "UNAUTHENTICATED",
      message: "无法验证当前会话，请重新登录。",
    };
  }
}
