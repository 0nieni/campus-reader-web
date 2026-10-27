import { createHash } from "node:crypto";
import { reject } from "./errors";

/** Only the CloudBase invocation adapter can produce this context in production. */
export interface Caller {
  uid: string;
  isAnonymous: boolean;
}
export interface IdentityContext {
  uid: string;
  dataOwnerId: string;
  legacyLinked: boolean;
  kind?:'guest'|'account';
}
export interface OwnerConfig {
  ownerUid?: string;
  legacyOpenid?: string;
  /** Trusted deployment namespace, never taken from browser input. */
  dataOwnerId?: string;
  guestWorkspace?:boolean;
}

export function identify(caller: Caller, config: OwnerConfig): IdentityContext {
  if (!caller.uid || caller.isAnonymous&&!config.guestWorkspace)
    reject("UNAUTHENTICATED", "请使用本人账号登录。");
  if (!config.ownerUid?.trim())
    reject(
      "OWNER_NOT_CONFIGURED",
      "网页尚未配置本人访问账号，请先完成云端账号配置。",
    );
  if (caller.uid !== config.ownerUid.trim())
    reject("FORBIDDEN", "当前账号没有这个个人工作区的访问权限。");
  const legacyOpenid = config.legacyOpenid?.trim();
  if(config.guestWorkspace&&(!/^guest_[a-f0-9]{32}$/.test(caller.uid)||config.dataOwnerId!==caller.uid))reject('FORBIDDEN','匿名工作区身份无效。');
  // A new verified Web owner starts in a distinct namespace; this never claims old mail.
  return {
    uid: caller.uid,
    dataOwnerId:
      config.dataOwnerId || legacyOpenid ||
      `web_${createHash("sha256").update(caller.uid).digest("hex")}`,
    legacyLinked: Boolean(legacyOpenid),
    ...(config.guestWorkspace?{kind:'guest' as const}:{}),
  };
}
