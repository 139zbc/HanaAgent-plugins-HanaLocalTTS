// HTTP 路由：面板和设置页调的所有接口。路由体从原 index.js 原样搬来。
import { errorDetail, failureText, logRouteError } from "./errors.js";
import { clampRate, listVoices, readHostSpeechPrefs } from "./powershell.js";
import {
  KOKORO_INSTALL_SOURCES,
  KOKORO_PIP_SOURCES,
  KOKORO_TORCH_SOURCES,
  checkGpuHardware,
  cleanInstallPath,
  dataDirUnder,
  ensureWatcher,
  hasNonAscii,
  kokoroRoot,
  kokoroStatus,
  readInstallState,
  readKokoroLive,
  pythonSource,
  runKokoroHelper,
  spawnKokoroService,
  startKokoroInstall,
  startKokoroService,
  stopKokoroService,
  stopWatcher,
} from "./kokoro.js";
import {
  clearReadyVoices,
  currentKokoroVoice,
  playbackStateSnapshot,
  readSpeechPrefs,
  speechProviderErrorSnapshot,
  speechSegmentCountSnapshot,
} from "./speech.js";
import { kokoroVoiceId } from "./kokoro.js";
import { KOKORO_VOICES } from "../kokoro-voices.js";
import {
  ensureKokoroReady,
  requestSpeech,
  speechTaskDone,
  speechTaskFailed,
  waitForSpeechTask,
} from "./speech-client.js";
import {
  effectivePython,
  portablePythonState,
  pythonDownloadProgress,
  startPythonDownload,
} from "../kokoro-runtime.js";

export const SPEECH_TEXT_MAX_BYTES = 32 * 1024; // 宿主的语音文本预算
export const SPEAK_TEXT_MAX_CHARS = 500; // 面板试听输入的上限

export function registerRoutes(sdk, app) {
    app.get("/probe", (c) => c.json({ ready: !speechProviderErrorSnapshot(), error: speechProviderErrorSnapshot() }));

    app.post("/probe", async (c) => {
      if (speechProviderErrorSnapshot()) return c.json({ ok: false, error: speechProviderErrorSnapshot() }, 500);
      try {
        await ensureKokoroReady(sdk);
        const result = await requestSpeech(sdk, "Hana Agent 的本地语音朗读，正常。");
        const taskId = result?.tasks?.[0]?.taskId;
        if (!taskId) return c.json({ ok: false, error: "宿主没有返回语音任务。", result }, 500);
        const task = await waitForSpeechTask(sdk, taskId);
        const completed = speechTaskDone(task);
        return c.json({
          ok: completed,
          error: completed ? "" : (task?.failReason || (speechTaskFailed(task) ? "语音合成没有成功。" : "语音任务没有在限定时间内完成。")),
          taskId,
          status: task?.status || "pending",
        }, completed ? 200 : 500);
      } catch (error) {
        return c.json({ ok: false, error: failureText(error) }, 500);
      }
    });

    // 面板的「试听」：把用户输入的任意文字走同一条宿主语音链路读出来。
    // 声音和语速不在这里选：宿主会按「多媒体 → 语音合成」里真正生效的那份设置来解析。
    app.get("/playback", (c) => c.json(playbackStateSnapshot()));

    app.post("/speak", async (c) => {
      if (speechProviderErrorSnapshot()) return c.json({ ok: false, error: speechProviderErrorSnapshot() }, 500);
      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ ok: false, error: "请求不是 JSON。" }, 400);
      }
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (!text) return c.json({ ok: false, error: "先写点要读的内容。" }, 400);
      const chars = Array.from(text).length;
      if (chars > SPEAK_TEXT_MAX_CHARS) {
        return c.json({ ok: false, error: `这段太长了（约 ${chars} 字），上限 ${SPEAK_TEXT_MAX_CHARS} 字。` }, 400);
      }
      try {
        // 冷启动挪到这里：合成之前先把服务拉起来，submit 里就只剩合成本身（三秒多），
        // 不会撞上宿主给回调的 30 秒上限。
        await ensureKokoroReady(sdk);
        const result = await requestSpeech(sdk, text);
        const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
        const taskIds = tasks.map((item) => item?.taskId).filter((value) => typeof value === "string" && value);
        if (taskIds.length === 0) return c.json({ ok: false, error: "宿主没有返回语音任务。" }, 500);
        // 宿主可能把长文拆成多个任务，每个都要等到落地。
        let completed = true;
        let failReason = "";
        for (const taskId of taskIds) {
          const task = await waitForSpeechTask(sdk, taskId);
          if (!speechTaskDone(task)) {
            completed = false;
            failReason = task?.failReason || (speechTaskFailed(task) ? "语音合成没有成功。" : "语音任务没有在限定时间内完成。");
            break;
          }
        }
        return c.json({
          ok: completed,
          error: completed ? "" : failReason,
          taskId: taskIds[0],
          status: completed ? "done" : "failed",
          // 切了段时任务会在音频播完之前就完成，页面要据此换一句提示。
          // 依据是适配器内部的分段数：切了段就是后台流水播放，任务先返回、音频后放完。
          segments: speechSegmentCountSnapshot(),
          playbackId: playbackStateSnapshot().id,
        }, completed ? 200 : 500);
      } catch (error) {
        return c.json({ ok: false, error: failureText(error) }, 500);
      }
    });

    app.get("/kokoro-status", async (c) => {
      try {
        const status = await kokoroStatus(sdk);
        if (status && status.running && !status.foreign) {
          ensureWatcher(sdk).catch((error) => {
            sdk.logger.warn(`kokoro watcher check failed: ${failureText(error)}`);
          });
        }
        return c.json(status);
      } catch (error) {
        return c.json({ error: failureText(error) }, 500);
      }
    });

    app.get("/kokoro-install", async (c) => {
      try {
        const root = await kokoroRoot(sdk);
        const state = await readInstallState(sdk, root);
        return c.json(state);
      } catch (error) {
        return c.json({ error: failureText(error) }, 500);
      }
    });

    // Python 运行环境：下载 App 自带的那份，或者切换用哪一份。
    app.get("/kokoro-python", async (c) => {
      try {
        const portable = await portablePythonState(sdk, sdk.dataDir);
        const progress = await pythonDownloadProgress(sdk.dataDir);
        const source = await pythonSource(sdk);
        const effective = await effectivePython(sdk, sdk.dataDir, source);
        return c.json({
          ok: true,
          ready: portable.ready,
          version: portable.version,
          source,
          effective,
          downloading: portable.downloading,
          percent: progress.percent || 0,
          bytes: progress.bytes || 0,
          total: progress.total || 0,
          message: progress.message || "",
          phase: progress.phase || "none",
        });
      } catch (error) {
        return c.json({ error: failureText(error) }, 500);
      }
    });

    app.post("/kokoro-python", async (c) => {
      try {
        const result = await startPythonDownload(sdk, sdk.dataDir);
        return c.json({ ok: true, ...result });
      } catch (error) {
        await sdk.logger.error(`kokoro python download failed: ${failureText(error)}`);
        return c.json({ ok: false, error: failureText(error, "Python 没下成") }, 500);
      }
    });

    app.put("/kokoro-python", async (c) => {
      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "请求不是 JSON。" }, 400);
      }
      const value = body && body.source;
      if (!["auto", "app", "system"].includes(value)) {
        return c.json({ error: "来源只能是自动、App 自带或系统。" }, 400);
      }
      try {
        await sdk.config.setMany({ kokoroPythonSource: value });
        await sdk.logger.info(`kokoro python source set to ${value}`);
        return c.json({ ok: true, source: value });
      } catch (error) {
        return c.json({ error: failureText(error) }, 500);
      }
    });

    app.post("/kokoro-install", async (c) => {
      let body;
      try {
        body = await c.req.json();
      } catch {
        body = null;
      }
      try {
        const component = body && body.component;
        if (component !== "model" && component !== "cpu" && component !== "gpu") {
          return c.json({ ok: false, error: "要指定下载模型、CPU 运行环境或 GPU 运行环境。" }, 400);
        }
        const requested = body && body.source;
        const pipSource = KOKORO_PIP_SOURCES[body && body.pipSource] || KOKORO_PIP_SOURCES[requested] || "tuna";
        const torchSource = KOKORO_TORCH_SOURCES[body && body.torchSource] || KOKORO_TORCH_SOURCES[requested] || "nju";
        let source = "modelscope";
        if (component === "model") {
          source = KOKORO_INSTALL_SOURCES[requested];
          if (!source) return c.json({ ok: false, error: "不认识的模型下载源。" }, 400);
        } else if (component === "cpu") {
          source = KOKORO_PIP_SOURCES[requested] || pipSource;
        } else {
          source = KOKORO_TORCH_SOURCES[requested] || torchSource;
        }
        // 数据目录只能在设置页里用「浏览」选。这里不再听客户端的路径。
        const root = await kokoroRoot(sdk);
        if (!root) return c.json({ ok: false, error: "还没选数据目录。先在「数据目录」里点「浏览」选一个。" }, 400);
        // 记住模型是从哪个源下的，换声音时补下声音文件优先用同一个源。
        // 写不进去也不能拦下下载：记不住就用默认的源。
        if (component === "model") {
          try {
            await sdk.config.setMany({ kokoroSource: source });
          } catch (error) {
            await sdk.logger.warn(`kokoro source not saved: ${errorDetail(error)}`);
          }
        }
        const status = await kokoroStatus(sdk);
        if (component === "model" && status.modelReady) return c.json({ ok: false, error: "模型已经下载好了。" }, 400);
        if (component === "cpu" && status.cpuReady) return c.json({ ok: false, error: "CPU 运行环境已经下载好了。" }, 400);
        if (component === "gpu" && status.gpuReady) return c.json({ ok: false, error: "GPU 运行环境已经下载好了。" }, 400);
        if (component === "gpu") {
          const gpu = await checkGpuHardware(sdk);
          if (!gpu.ok) return c.json({ ok: false, error: gpu.error }, 400);
        }
        const installVoice = component === "model" ? await currentKokoroVoice(sdk) : "";
        const result = await startKokoroInstall(sdk, root, source, pipSource, torchSource, component, sdk.dataDir, installVoice);
        return c.json(result);
      } catch (error) {
        await logRouteError(sdk, "kokoro install failed", error);
        return c.json({ ok: false, error: failureText(error, "下载失败") }, 500);
      }
    });

    // 改数据目录：用户在宿主里挑了一个文件夹，App 在里面建一个自己的子目录。
    app.put("/kokoro-path", async (c) => {
      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "请求不是 JSON。" }, 400);
      }
      const picked = cleanInstallPath(body && body.root);
      if (!picked) return c.json({ error: "要选一个完整的文件夹。" }, 400);
      if (picked.length > 160) return c.json({ error: "路径太长。" }, 400);
      // 路径里不能有中文：espeak-ng 的 dll 处理不了非 ASCII 路径，服务会起不来。
      if (hasNonAscii(picked)) {
        return c.json({ error: "这个路径里有中文或特殊字符，装不了。请选一个纯英文数字的文件夹，比如 D:\\Models。" }, 400);
      }
      const root = dataDirUnder(picked);
      const previous = await kokoroRoot(sdk);
      // 先验目录：建得出来、写得了，才往下走。别等下了 5GB 才发现这个盘写不了。
      // 校验要靠助手（Node 权限模型读不到用户目录），所以机器上还没 Python 时
      // 只能先记下路径，等 Python 装好了再验。
      let check = null;
      try {
        check = await runKokoroHelper(sdk, ["check-dir", "--root", root], { timeoutMs: 60000 });
      } catch (error) {
        const raw = String((error && error.message) || "");
        if (!/找不到能用的 Python/.test(raw)) {
          return c.json({ error: failureText(error, "这个目录用不了") }, 400);
        }
        await sdk.logger.info("kokoro path saved without check: no python yet");
      }
      // 换目录前先停旧目录里我们自己的服务。不按 /health 报的目录去停。
      let stopped = [];
      if (previous && previous !== root) {
        try {
          const result = await stopKokoroService(sdk, previous);
          stopped = result.stopped || [];
          await sdk.logger.info(`kokoro stopped before path change: ${stopped.join(",") || "none"}`);
        } catch (error) {
          await sdk.logger.error(`kokoro stop before path change failed: ${failureText(error)}`);
        }
      }
      try {
        await sdk.config.setMany({ kokoroRoot: root });
      } catch (error) {
        return c.json({ error: failureText(error) }, 500);
      }
      // 声音文件是按目录放的，换了目录要重新确认一遍。
      clearReadyVoices();
      await sdk.logger.info(`kokoro root set to ${root}`);
      return c.json({ ok: true, root, picked, previous, checked: !!check, freeBytes: (check && check.freeBytes) || 0, stopped });
    });

    app.post("/kokoro-start", async (c) => {
      try {
        const status = await kokoroStatus(sdk);
        if (!status.modelReady) return c.json({ ok: false, error: "模型未下载。" }, 400);
        if (status.targetDevice === "cuda" && !status.gpuReady) return c.json({ ok: false, error: "GPU 运行环境未下载。" }, 400);
        if (status.targetDevice !== "cuda" && !status.cpuReady) return c.json({ ok: false, error: "CPU 运行环境未下载。" }, 400);
        if (status.running && !status.foreign) return c.json({ ok: true, alreadyRunning: true });
        if (status.running && status.foreign) {
          // 端口上是另一份数据目录的服务。不停它，避免按别人报的目录杀进程。
          return c.json({ ok: false, error: "8765 端口上是另一份数据目录的服务，没有动它。" }, 409);
        }
        const result = await startKokoroService(sdk);
        return c.json(result);
      } catch (error) {
        await logRouteError(sdk, "kokoro start failed", error);
        return c.json({ ok: false, error: failureText(error, "启动失败") }, 500);
      }
    });

    app.post("/kokoro-stop", async (c) => {
      try {
        const status = await kokoroStatus(sdk);
        const root = await kokoroRoot(sdk);
        if (!root) return c.json({ ok: true, stopped: [] });
        // 只停当前保存的数据目录。端口上若是另一份，留着不动。
        const result = await stopKokoroService(sdk, root);
        if (status.foreign) {
          return c.json({ ok: false, stopped: result.stopped, error: "8765 端口上是另一份数据目录的服务，没有动它。" }, 409);
        }
        return c.json(result);
      } catch (error) {
        await logRouteError(sdk, "kokoro stop failed", error);
        return c.json({ ok: false, error: failureText(error, "停止失败") }, 500);
      }
    });

    app.get("/kokoro-live", async (c) => {
      const live = await readKokoroLive(sdk);
      return c.json(live);
    });

    app.post("/kokoro-device", async (c) => {
      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "请求不是 JSON。" }, 400);
      }
      const target = body && body.device === "cuda" ? "cuda" : "cpu";
      try {
        const status = await kokoroStatus(sdk);
        const current = status.targetDevice === "cuda" ? "cuda" : "cpu";
        if (target === "cuda" && !status.gpuReady) return c.json({ ok: false, error: "GPU 运行环境未下载。" }, 400);
        if (target === "cpu" && !status.cpuReady) return c.json({ ok: false, error: "CPU 运行环境未下载。" }, 400);
        if (current === target) return c.json({ ok: true, device: target, unchanged: true });
        if (status.foreign) return c.json({ ok: false, error: "服务是从另一个目录启动的，不能在这里换。" }, 400);
        const wasRunning = status.running === true;
        if (!wasRunning) {
          await sdk.config.setMany({ kokoroDevice: target });
          await sdk.logger.info(`kokoro device saved as ${target} (service was stopped)`);
          return c.json({ ok: true, device: target, pending: false });
        }
        await stopKokoroService(sdk);
        await sdk.config.setMany({ kokoroDevice: target });
        await spawnKokoroService(sdk);
        await sdk.logger.info(`kokoro device switch started toward ${target}`);
        return c.json({ ok: true, device: target, pending: true });
      } catch (error) {
        await logRouteError(sdk, "kokoro device switch failed", error);
        return c.json({ ok: false, error: failureText(error, "切换失败") }, 500);
      }
    });

    app.put("/kokoro-autostop", async (c) => {
      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "请求不是 JSON。" }, 400);
      }
      const enabled = !!(body && body.enabled === true);
      try {
        await sdk.config.setMany({ kokoroAutoStop: enabled });
        if (enabled) {
          const status = await kokoroStatus(sdk);
          if (status.running) {
            await ensureWatcher(sdk);
            await sdk.logger.info("kokoro watcher enabled by user");
          }
        } else {
          await stopWatcher(sdk);
          await sdk.logger.info("kokoro watcher disabled by user");
        }
        return c.json({ ok: true, enabled });
      } catch (error) {
        return c.json({ error: failureText(error) }, 500);
      }
    });

    app.get("/voices", async (c) => {
      try {
        const voices = await listVoices(sdk);
        const local = await readSpeechPrefs(sdk);
        // 宿主那份优先：面板要显示多媒体页面里真正生效的值。
        const host = await readHostSpeechPrefs(sdk);
        const prefs = host || local;
        return c.json({
          voices,
          kokoroVoices: KOKORO_VOICES,
          ...prefs,
          prefsSource: host ? "host" : "app",
        });
      } catch (error) {
        return c.json({ error: failureText(error) }, 500);
      }
    });

    app.put("/preferences", async (c) => {
      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "请求不是 JSON。" }, 400);
      }
      const voice = body && typeof body.voice === "string" ? body.voice.trim() : "";
      const rate = clampRate(body && body.rate);
      const engine = body && body.engine === "kokoro" ? "kokoro" : "system";
      const kokoroVoice = kokoroVoiceId(body && body.kokoroVoice);
      if (voice.length > 120) return c.json({ error: "声音名称太长。" }, 400);
      try {
        await sdk.config.setMany({ voice, rate, engine, kokoroVoice });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: message.slice(0, 180) }, 400);
      }
      await sdk.logger.info(`prefs saved engine=${engine} rate=${rate} kokoroVoice=${kokoroVoice}`);
      return c.json({ ok: true, voice, rate, engine, kokoroVoice });
    });
}
