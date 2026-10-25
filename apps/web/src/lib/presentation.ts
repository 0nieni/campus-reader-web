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
    SOURCE_LOGIN_REQUIRED:{title:'需要登录或校园网',advice:'请打开原站，按学校要求使用登录或校园网；本站不会代为登录。'},
    SOURCE_RESTRICTED:{title:'原站限制访问',advice:'请打开原站完成允许的访问验证，本站不会绕过限制。'},
    SOURCE_ROBOTS_BLOCKED:{title:'原站不允许自动采集',advice:'请通过原站阅读，不自动重试受限路径。'},
    SOURCE_PARSE_FAILED:{title:'公告列表无法解析',advice:'先打开原站核对栏目；个人来源可调整高级解析设置，内置来源需维护者适配。'},
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
