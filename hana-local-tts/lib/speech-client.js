// 宿主语音任务链路：等任务完成、向宿主发起语音合成、按需拉起 Kokoro 服务。
import { PROVIDER_ID } from "./speech.js";
import { KOKORO_TIMEOUT_MS, readHostSpeechPrefs, savedSpeed, speedTypeError, textResult } from "./powershell.js";
import { kokoroStatus, readKokoroLive, startKokoroService } from "./kokoro.js";

export function speechTaskFailed(task) {
  const status = task && typeof task.status === "string" ? task.status : "";
  return status === "failed" || status === "error";
}

export function speechTaskDone(task) {
  const status = task && typeof task.status === "string" ? task.status : "";
  return status === "done" || status === "completed";
}

export async function waitForSpeechTask(sdk, taskId) {
  const deadline = Date.now() + KOKORO_TIMEOUT_MS;
  let task = null;
  while (Date.now() < deadline) {
    task = await sdk.media.getTask(taskId);
    if (task && task.status && task.status !== "pending") return task;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return task;
}

export async function requestSpeech(sdk, text, speed) {
  const input = {
    text,
    providerId: PROVIDER_ID,
    format: "wav",
    delivery: { mode: "response" },
  };
  if (typeof speed === "number") input.speed = speed;
  try {
    return await sdk.bus.request("media:generate-speech", { scope: "app", input });
  } catch (error) {
    if (typeof speed === "number" || !speedTypeError(error)) throw error;
    input.speed = await savedSpeed(sdk);
    return sdk.bus.request("media:generate-speech", { scope: "app", input });
  }
}

// 合成之前按需把 Kokoro 服务拉起来。
//
// 为什么不能放在适配器的 submit 里：宿主回调 App 的普通 RPC 只有 30 秒，而
// 冷启动要十几秒（加载模型），塞进去超时就报「submit timed out」，用户只看到
// 一句没头没尾的失败。放在这里（App 自己的通道，媒体调用另有十分钟预算）就绕开了。
//
// 两个调用方都要走这一步：面板的 /speak 路由，和助手消息朗读的 synthesize()。
// 合成本身只要三秒多，稳在 30 秒里。
export async function ensureKokoroReady(sdk) {
  // 读不到宿主设置就不知道会不会用到 Kokoro：不动，交给适配器里的自动启动兜底。
  const prefs = await readHostSpeechPrefs(sdk);
  if (!prefs || prefs.engine !== "kokoro") return { started: false };
  const live = await readKokoroLive(sdk);
  if (live.running) return { started: false };
  // 模型没装好就别起服务了：服务起不来要等 180 秒才报错，白等。
  const status = await kokoroStatus(sdk);
  if (!status.installed) return { started: false };
  await sdk.logger.info("kokoro not running, starting before synthesis");
  await startKokoroService(sdk);
  await sdk.logger.info("kokoro started for synthesis");
  return { started: true };
}

export async function synthesize(sdk, text) {
  await ensureKokoroReady(sdk);
  const result = await requestSpeech(sdk, text);
  const taskId = result?.tasks?.[0]?.taskId;
  if (!taskId) return textResult("宿主没有返回语音任务。");
  const task = await waitForSpeechTask(sdk, taskId);
  if (!speechTaskDone(task)) {
    return textResult(task?.failReason || (speechTaskFailed(task) ? "语音合成没有成功。" : "语音任务没有在限定时间内完成。"));
  }
  await sdk.logger.info(`speak ok task=${taskId}`);
  return textResult("已朗读。");
}
