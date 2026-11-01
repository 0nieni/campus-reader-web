export function displayTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "发布时间未标注";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
export function safeOriginal(value: string | null): string | null {
  try {
    const url = new URL(value || "");
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function displaySourceTime(value?:string|null):string {
  if(!value||!Number.isFinite(Date.parse(value)))return '尚无记录';
  return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
}
export function sourceDiagnosis(code?:string|null):{title:string;advice:string}|null {
  if(!code)return null;
  const known:Record<string,{title:string;advice:string}>={
    LEXMOUNT_NOT_CONFIGURED:{title:'采集服务待配置',advice:'请联系网站维护者完成采集服务配置；已有有效公告仍可阅读。'},
    LEXMOUNT_AUTH_FAILED:{title:'采集服务凭据无效',advice:'请联系网站维护者核对服务端项目配置，稍后再试。'},
    LEXMOUNT_QUOTA_EXHAUSTED:{title:'采集服务额度已用完',advice:'请联系网站维护者检查服务额度；已有有效公告仍可阅读。'},
    LEXMOUNT_REGION_BLOCKED:{title:'采集服务区域不匹配',advice:'请联系网站维护者核对项目区域和服务入口。'},
    LEXMOUNT_RATE_LIMITED:{title:'采集请求过于频繁',advice:'请稍后重试，避免重复点击采集。'},
    LEXMOUNT_TIMEOUT:{title:'本次采集超时',advice:'已有公告保留，请稍后重试或查看原站。'},
    SOURCE_LOGIN_REQUIRED:{title:'需要登录或校园网',advice:'请打开原站，按学校要求使用登录或校园网；本站不会代为登录。'},
    SOURCE_RESTRICTED:{title:'原站限制访问',advice:'请打开原站完成允许的访问验证，本站不会绕过限制。'},
    SOURCE_ROBOTS_BLOCKED:{title:'原站不允许自动采集',advice:'请通过原站阅读，不自动重试受限路径。'},
    SOURCE_PARSE_FAILED:{title:'公告列表无法解析',advice:'先打开原站核对栏目；个人来源可调整高级解析设置，内置来源需维护者适配。'},
    SOURCE_DYNAMIC_PAGE:{title:'动态页面未取得公告内容',advice:'原站依赖脚本加载，本次没有取得可读取的公告。可打开原站查看，或联系维护者配置公开公告入口。'},
    SOURCE_UNSUPPORTED_TYPE:{title:'文件入口暂不支持网页更新',advice:'此链接是文件，不能按公告网页列表更新。请打开原站，或选择主办方的公开公告栏目。'},
    SOURCE_NOT_FOUND:{title:'来源入口不存在',advice:'请打开学校官网核对新入口；个人来源更换网址需重新添加。'},
    SOURCE_INTERVAL:{title:'尚在采集冷却期',advice:'请按卡片中的下次可采集时间重试；已有公告仍可阅读。'},
    SOURCE_BUSY:{title:'来源正在处理中',advice:'请稍候再试，避免重复提交。'},
    SOURCE_DAILY_LIMIT:{title:'今日来源请求次数已用完',advice:'请明天再采集，不影响阅读已保存的公告。'},
    SOURCE_DISABLED:{title:'来源已停用',advice:'需要继续采集时请先启用来源。'},
  };
  return known[code]||{title:'连接或读取未成功',advice:'暂时无法确定具体原因。请打开原站核对，稍后重试；已有公告保留。'};
}
export const categoryNames: Record<string, string> = {
  school: "学校",
  college: "学院",
  competition: "竞赛",
  academic: "学术",
  activity: "活动",
  scholarship: "奖学金",
  mail: "邮件",
};
