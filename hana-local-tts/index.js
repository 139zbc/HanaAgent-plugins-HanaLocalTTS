// Hana 本地语音朗读 App：入口。
// 结构：lib/powershell.js（PowerShell 调用）→ lib/kokoro.js（本地模型管理）
// → lib/speech.js（合成与适配器）+ lib/speech-client.js（宿主语音链路）
// → lib/routes.js（HTTP 路由）。
import { errorDetail, failureText } from "./lib/errors.js";
import { listVoices } from "./lib/powershell.js";
import {
  cleanupOrphanKokoro,
  cleanupTempDirs,
  ensureWatcherWhenReady,
  startCleanupLoop,
} from "./lib/kokoro.js";
import {
  registerSpeechProvider,
  setSystemVoiceCache,
  speechProviderErrorSnapshot,
} from "./lib/speech.js";
import { synthesize } from "./lib/speech-client.js";
import { registerRoutes, SPEECH_TEXT_MAX_BYTES } from "./lib/routes.js";
import { textResult } from "./lib/powershell.js";
import { defineApp } from "./sdk/app-contract/server-client.js";

export const name = "hana-local-tts";

export default defineApp(async (sdk) => {
  await sdk.logger.info("hana-local-tts loaded");
  try {
    setSystemVoiceCache(await listVoices(sdk));
  } catch (error) {
    setSystemVoiceCache([]);
    await sdk.logger.error(`system voices unavailable: ${failureText(error)}`);
  }
  await registerSpeechProvider(sdk);
  // 方案 A：先清理上次遗留的服务，再拉守护进程（方案 B）
  await cleanupOrphanKokoro(sdk);
  // 守护进程和清理都要读配置，而配置要等宿主把设置贡献挂上来才读得到。
  // 这两件事不挡着路由注册，挂在后台等就行。
  ensureWatcherWhenReady(sdk);
  // 定时清理临时目录：服务跑一次会攒一份 espeak-ng.dll 的副本。
  startCleanupLoop(sdk);
  cleanupTempDirs(sdk, true).catch((error) => {
    sdk.logger.warn(`temp cleanup start failed: ${errorDetail(error)}`);
  });

  await sdk.routes.register((app) => {
    registerRoutes(sdk, app);
  });

  await sdk.tools.register({
    name: "hana_local_tts_speak",
    description: "用 Windows 系统语音朗读当前这条助手消息。",
    parameters: { type: "object", properties: {} },
    execute: async (args) => {
      const raw = typeof args?.context?.messageText === "string" ? args.context.messageText.trim() : "";
      if (!raw) return textResult("这条消息没有可朗读的文字。");
      const chars = Array.from(raw);
      // 不再自己截 800 字：长文交给 submit 按句分段。只卡宿主的 32KB 文本预算。
      const text = raw;
      if (new TextEncoder().encode(text).length > SPEECH_TEXT_MAX_BYTES) {
        return textResult(`这条消息太长了（约 ${chars.length} 字），超过了语音合成的上限。请分段朗读。`);
      }
      try {
        const result = await synthesize(sdk, text);
        return result;
      } catch (error) {
        await sdk.logger.error(failureText(error));
        return textResult(failureText(error));
      }
    },
  });
});
