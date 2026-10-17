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
export const categoryNames: Record<string, string> = {
  school: "学校",
  college: "学院",
  competition: "竞赛",
  academic: "学术",
  activity: "活动",
  scholarship: "奖学金",
  mail: "邮件",
};
