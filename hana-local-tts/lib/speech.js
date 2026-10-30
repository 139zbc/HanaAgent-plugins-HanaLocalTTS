// 语音合成与播放：分段、写 wav、流水线播放、多媒体语音适配器注册。
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { KOKORO_VOICES } from "../kokoro-voices.js";
import { failureText } from "./errors.js";
import { buildScript, clampRate, playWavFile, powershellPath, readHostSpeechPrefs, runPowerShell } from "./powershell.js";
import { KOKORO_DEFAULT_VOICE, KOKORO_INSTALL_SOURCES, ensureWatcher, kokoroDevice, kokoroRoot, kokoroVoiceId, runKokoroHelper } from "./kokoro.js";

export const PROVIDER_ID = "hana-local-tts";
export const PROTOCOL_ID = "hana-local-tts-sapi";
const ADAPTER_ID = "hana-local-tts-speech";
const MODEL_ID = "windows";

let speechProviderError = "";
let systemVoiceCache = [];

// 声音文件按需补下：换声音时只下那一个（约 0.5MB）。已经确认过的记在内存里，
// 不重复问助手；合成失败时清掉，下次重新确认，声音文件被删了也能自愈。
const readyVoices = new Set();

// 换了数据目录，之前确认过的声音文件不在新目录里，要把记录清掉。
//
// 为什么不直接导出 readyVoices：集合本身是模块内部状态，别的模块只该「清一下」。
// 之前这里没导出、调用方也没 import，路由跑到这一行直接抛 ReferenceError，
// 改数据目录整个失败（实测：新电脑装完按引导选目录，一直提示没保存）。
export function clearReadyVoices() {
  readyVoices.clear();
}

// 装模型时带哪个声音：宿主多媒体里选的那个，读不到就用 App 自己存的、再读不到用默认。
export async function currentKokoroVoice(sdk) {
  const host = await readHostSpeechPrefs(sdk);
  if (host && host.kokoroVoice) return host.kokoroVoice;
  const local = await readSpeechPrefs(sdk);
  return local.kokoroVoice || KOKORO_DEFAULT_VOICE;
}

async function kokoroVoiceSource(sdk) {
  try {
    const all = await sdk.config.getAll();
    const source = all && typeof all.kokoroSource === "string" ? all.kokoroSource : "";
    return KOKORO_INSTALL_SOURCES[source] || "";
  } catch {
    return "";
  }
}

async function ensureVoiceFile(sdk, root, voice) {
  if (readyVoices.has(voice)) return;
  const source = await kokoroVoiceSource(sdk);
  const args = ["voice", "--root", root, "--id", voice];
  if (source) args.push("--source", source);
  await runKokoroHelper(sdk, args, { timeoutMs: 120000 });
  readyVoices.add(voice);
  await sdk.logger.info(`kokoro voice ready: ${voice}`);
}

export async function writeSpeechFile(sdk, text, voice, rate, wavFile, engine, play = true) {
  const textFile = `${wavFile}.txt`;
  if (engine === "kokoro") {
    await writeFile(textFile, text, "utf8");
    try {
      const kokoroVoice = kokoroVoiceId(voice);
      const root = await kokoroRoot(sdk);
      // 换声音时只补下那一个声音文件；已经在本地就快速返回。
      await ensureVoiceFile(sdk, root, kokoroVoice);
      try {
        // 合成交给助手：它会保证服务在跑，再请求本机服务出声。
        await runKokoroHelper(
          sdk,
          [
            "speak",
            "--root", root,
            "--device", await kokoroDevice(sdk),
            "--text-file", textFile,
            "--out", wavFile,
            "--voice", kokoroVoice,
            "--speed", String(clampRate(rate)),
          ],
          { timeoutMs: 280000 },
        );
        if (play) await playWavFile(sdk, wavFile);
      } catch (error) {
        // 声音文件可能被外面动了；下次重新确认一遍。
        readyVoices.delete(kokoroVoice);
        error.kokoro = true;
        throw error;
      }
      await ensureWatcher(sdk);
    } finally {
      await rm(textFile, { force: true });
    }
    return;
  }
  const executable = await powershellPath(sdk);
  if (!executable) throw new Error("找不到 Windows PowerShell，没法把声音放出来。");
  await writeFile(textFile, text, "utf8");
  try {
    const preferChinese = /[\u4e00-\u9fff]/.test(text);
    await runPowerShell(executable, buildScript(textFile, wavFile, voice, rate, preferChinese, play));
  } finally {
    await rm(textFile, { force: true });
  }
}

// 按句子切段：中文句末标点、英文句号、换行都算一段结束。
// 太短的相邻段合并，避免一句一句合成拖慢整体。
const SEGMENT_SOFT_LIMIT = 220;
const SEGMENT_HARD_LIMIT = 320;

export function splitIntoSegments(rawText) {
  const text = String(rawText || "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const pieces = text.split(/(?<=[。！？；!?;\n])/);
  const segments = [];
  let buffer = "";
  const flush = () => {
    const value = buffer.trim();
    if (value) segments.push(value);
    buffer = "";
  };
  for (const piece of pieces) {
    if (!piece) continue;
    // 单句超过硬上限时，按逗号再切
    if (Array.from(piece).length > SEGMENT_HARD_LIMIT) {
      flush();
      const chunks = piece.split(/(?<=[，,、：:])/);
      for (const chunk of chunks) {
        if (!chunk) continue;
        // 连逗号都没有的超长块：按字数硬切
        let rest = chunk;
        while (Array.from(rest).length > SEGMENT_HARD_LIMIT) {
          const head = Array.from(rest).slice(0, SEGMENT_SOFT_LIMIT).join("");
          segments.push(head);
          rest = Array.from(rest).slice(SEGMENT_SOFT_LIMIT).join("");
        }
        if (!rest) continue;
        if (Array.from(buffer).length + Array.from(rest).length > SEGMENT_HARD_LIMIT) flush();
        buffer += rest;
        if (Array.from(buffer).length >= SEGMENT_SOFT_LIMIT) flush();
      }
      continue;
    }
    if (Array.from(buffer).length + Array.from(piece).length > SEGMENT_SOFT_LIMIT) flush();
    buffer += piece;
    if (Array.from(buffer).length >= SEGMENT_SOFT_LIMIT) flush();
  }
  flush();
  return segments;
}

// 流水线播放剩余段：当前段在放的同时，后台已在合下一段。
// segments 不含已合好的第一段，所以 segments[0] 就是第二段。
async function discardWav(file) {
  if (!file) return;
  await rm(file, { force: true }).catch(() => {});
}

async function playRemainingSegments(sdk, dir, segments, voice, speed, engine, total, firstFile) {
  const tempFile = () => path.join(dir, `speech-${randomBytes(8).toString("hex")}.wav`);
  const prepare = (text) => {
    const target = tempFile();
    return writeSpeechFile(sdk, text, voice, speed, target, engine, false).then(() => target).catch(async (error) => {
      await discardWav(target);
      throw error;
    });
  };

  // 第一段已在 firstFile 里。先把第二段的合成发出去，再播第一段。
  let currentFile = firstFile;
  let nextReady = segments.length > 0 ? prepare(segments[0]) : null;
  let playedIndex = 0;
  let failed = null;

  try {
    while (currentFile) {
      try {
        await playWavFile(sdk, currentFile);
        playedIndex += 1;
        await sdk.logger.info(`speech segment ${playedIndex}/${total} played`);
      } catch (error) {
        await discardWav(currentFile);
        currentFile = "";
        failed = error;
        break;
      }
      // 第一段留给宿主的任务结果。后面的临时段播完就删。
      if (currentFile !== firstFile) await discardWav(currentFile);

      if (!nextReady) break;
      try {
        currentFile = await nextReady;
        nextReady = null;
      } catch (error) {
        failed = error;
        break;
      }
      nextReady = segments.length > playedIndex ? prepare(segments[playedIndex]) : null;
    }
  } finally {
    if (failed && nextReady) {
      nextReady.then((file) => discardWav(file)).catch(() => {});
    }
  }
  if (failed) throw failed;
}

function speechMode(defaultVoice) {
  return {
    id: "text2speech",
    label: "文本转语音",
    defaults: { format: "wav", voice: defaultVoice, speed: 1 },
    parameterSchema: {
      type: "object",
      properties: {
        voice: { type: "string", title: "声音", default: defaultVoice },
        speed: { type: "number", title: "语速", minimum: 0.5, maximum: 2, default: 1 },
        format: { type: "string", title: "格式", enum: ["wav"], default: "wav" },
      },
    },
  };
}

export function speechModelSnapshot() {
  const windowsVoices = [
    { id: "auto", displayName: "自动（中文优先）" },
    ...systemVoiceCache.map((item) => ({
      id: item.name,
      displayName: item.culture ? `${item.name}（${item.culture}）` : item.name,
    })),
  ];
  return {
    media: {
      speech_generation: {
        defaultModelId: MODEL_ID,
        models: [
          {
            id: MODEL_ID,
            displayName: "Windows 系统语音",
            protocolId: PROTOCOL_ID,
            defaultVoiceId: "auto",
            voices: windowsVoices,
            modes: [speechMode("auto")],
          },
          {
            id: "kokoro",
            displayName: "本地模型",
            protocolId: PROTOCOL_ID,
            defaultVoiceId: KOKORO_DEFAULT_VOICE,
            voices: KOKORO_VOICES.map((item) => ({ id: item.id, displayName: item.label })),
            modes: [speechMode(KOKORO_DEFAULT_VOICE)],
          },
        ],
      },
    },
  };
}

// 正在朗读。第二次点不排队，直接拒绝，避免卡在宿主 30 秒超时里。
let speechBusy = false;
let speechSegmentCount = 0;
let playbackState = { id: 0, state: "idle", message: "" };

function beginPlayback() {
  playbackState = { id: playbackState.id + 1, state: "playing", message: "" };
  return playbackState.id;
}

function finishPlayback(id) {
  if (playbackState.id !== id) return;
  playbackState = { id, state: "done", message: "" };
}

function failPlayback(id, message) {
  if (playbackState.id !== id) return;
  playbackState = { id, state: "failed", message: String(message || "朗读失败。").slice(0, 180) };
}

function claimSpeech() {
  if (speechBusy) throw new Error("正在朗读，等这一段结束再试。");
  speechBusy = true;
}

function releaseSpeech() {
  speechBusy = false;
}

export async function registerSpeechProvider(sdk) {
  speechProviderError = "";
  try {
    await sdk.media.registerAdapter({
      id: ADAPTER_ID,
      protocolId: PROTOCOL_ID,
      name: "本地语音朗读",
      displayName: "本地语音朗读",
      types: ["speech"],
      capabilities: { formats: ["wav"], speedMin: 0.5, speedMax: 2 },
      checkAuth() {
        return { ok: true };
      },
      async submit(params, hostCtx) {
        const text = String(params?.text || params?.prompt || "").trim();
        if (!text) throw new Error("speech synthesis requires non-empty text");
        const format = params?.format || "wav";
        if (format !== "wav") throw new Error(`speech format "${format}" is not supported`);
        const dir = hostCtx?.generatedDir;
        if (!dir) throw new Error("speech synthesis requires generatedDir");
        const modelId = String(params?.modelId || params?.model || "");
        const engine = modelId === "kokoro" ? "kokoro" : "system";
        const voice = params?.voice && params.voice !== "auto" ? String(params.voice) : "";
        const speed = clampRate(params?.speed);
        await mkdir(dir, { recursive: true });

        const segments = splitIntoSegments(text);
        if (segments.length === 0) throw new Error("speech synthesis requires non-empty text");
        speechSegmentCount = segments.length;
        claimSpeech();
        let playbackStarted = false;
        try {
          const name = `speech-${randomBytes(8).toString("hex")}.wav`;
          const taskId = typeof params?.taskId === "string" && params.taskId ? params.taskId : name;
          const firstFile = path.join(dir, name);
          const rest = segments.slice(1);
          await writeSpeechFile(sdk, segments[0], voice, speed, firstFile, engine, false);
          await sdk.logger.info(`speech provider wrote ${name} (1/${segments.length} segments, ${rest.length} queued)`);
          playbackStarted = true;
          const playbackId = beginPlayback();
          // 播放放后台，但占用一直留到播完。这期间再点朗读会被拒绝。
          playRemainingSegments(sdk, dir, rest, voice, speed, engine, segments.length, firstFile).then(() => {
            finishPlayback(playbackId);
          }).catch(async (error) => {
            const message = failureText(error);
            failPlayback(playbackId, message);
            await sdk.logger.error(`speech playback failed: ${message}`);
          }).finally(releaseSpeech);
          return { taskId, files: [name] };
        } catch (error) {
          if (!playbackStarted) releaseSpeech();
          throw error;
        }
      },
    });
    await sdk.media.registerCapabilitySource(PROVIDER_ID, {
      refresh() {
        return speechModelSnapshot();
      },
    });
    await sdk.logger.info("speech provider registered");
  } catch (error) {
    speechProviderError = failureText(error);
    await sdk.logger.error(`speech provider not registered: ${speechProviderError}`);
  }
}

export function playbackStateSnapshot() {
  return playbackState;
}

export function speechSegmentCountSnapshot() {
  return speechSegmentCount;
}

export function speechProviderErrorSnapshot() {
  return speechProviderError;
}

export function setSystemVoiceCache(voices) {
  systemVoiceCache = Array.isArray(voices) ? voices : [];
}

export async function readSpeechPrefs(sdk) {
  try {
    const all = await sdk.config.getAll();
    const voice = all && typeof all.voice === "string" ? all.voice : "";
    const rate = clampRate(all && all.rate);
    const engine = all && all.engine === "kokoro" ? "kokoro" : "system";
    const kokoroVoice = kokoroVoiceId(all && all.kokoroVoice);
    return { voice, rate, engine, kokoroVoice };
  } catch {
    return { voice: "", rate: 1, engine: "system", kokoroVoice: KOKORO_DEFAULT_VOICE };
  }
}
