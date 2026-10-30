// 错误文案与日志格式化。全 App 共用，被所有 lib 模块引用，自己不引别人。
export async function logRouteError(sdk, label, error) {
  const detail = [error && error.message, error && error.stderr].filter(Boolean).join(" | ").slice(0, 800);
  await sdk.logger.error(`${label}: ${detail || "no detail"}`);
}

function psErrorText(raw) {
  const text = String(raw || "");
  if (!text.includes("#< CLIXML")) return text;
  const parts = [];
  const re = /<S S="Error">([\s\S]*?)<\/S>/g;
  let match;
  while ((match = re.exec(text)) !== null) parts.push(match[1]);
  if (parts.length === 0) return text;
  return parts.join("\n")
    .replace(/_x000D_/g, "")
    .replace(/_x000A_/g, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function usefulLine(raw) {
  return psErrorText(raw).split(/\r?\n/).map((item) => item.trim()).find((item) => {
    if (!item || item.startsWith("#<") || item.startsWith("<")) return false;
    if (item.startsWith("Command failed:")) return false;
    if (item.startsWith("+ ")) return false;
    if (/^(CategoryInfo|FullyQualifiedErrorId|所在位置|At line|At char)/.test(item)) return false;
    return true;
  }) || "";
}

export function errorDetail(error) {
  const parts = [
    error && error.code,
    error && error.permission,
    error && error.resource,
    error && error.message,
    error && error.stack ? String(error.stack).split("\n").slice(0, 3).join(" | ") : "",
  ].filter(Boolean);
  return parts.join(" · ").slice(0, 600);
}

export function failureText(error, label = "朗读失败") {
  const code = error && error.code;
  const raw = `${error && error.message ? error.message : error}\n${error && error.stderr ? error.stderr : ""}`;
  if (/app\/media\.provide/i.test(raw)) {
    return "还没有「提供媒体」权限。请在设置 → 应用能力里允许，然后重新加载这个 App。";
  }
  if (/app\/media\.generate/i.test(raw)) {
    return "还没有「生成媒体」权限。请在设置 → 应用能力里允许，然后重新加载这个 App。";
  }
  if (code === "ERR_ACCESS_DENIED" || /process\.spawn|APP_CAPABILITY_DENIED|EPERM/i.test(raw)) {
    if (label === "朗读失败") return "还不能朗读。请在设置里允许这个 App 启动进程，然后重新加载它。";
    const what = error && error.permission ? error.permission : "启动子进程";
    return `${label}：App 进程被宿主限制了（${what}）。请在设置 → 应用能力里允许「启动进程」，然后重新加载这个 App。`;
  }
  if (code === "ETIMEDOUT" || /timed out/i.test(raw)) {
    if (error && error.kokoro) return "本地模型没能在限定时间内启动或读完。请再点一次。";
    if (label !== "朗读失败") return `${label}：超过了等待时间。`;
    return "这句话太长，系统语音没能在限定时间内读完。请换短一点的消息。";
  }
  const line = usefulLine(raw);
  if (line) return `${label}：${line.slice(0, 180)}`;
  if (code !== undefined && code !== null && code !== "") {
    return `${label}：没有返回具体原因（PowerShell 退出码 ${code}${error && error.killed ? "，等待超时被终止" : ""}）。`;
  }
  return `${label}：${String(error && error.message ? error.message : error).slice(0, 180)}`;
}
