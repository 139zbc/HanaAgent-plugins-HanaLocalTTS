import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp } from "./sdk/app-contract/server-client.js";
import { KOKORO_VOICES } from "./kokoro-voices.js";
import { runHelper, spawnDetached, startInstall, writeAppSources, portablePythonState, pythonDownloadProgress, startPythonDownload, effectivePython } from "./kokoro-runtime.js";

export const name = "hana-local-tts";

const SPEECH_TEXT_MAX_BYTES = 32 * 1024; // 宿主的语音文本预算
const SPEAK_TEXT_MAX_CHARS = 500; // 面板试听输入的上限
const SPEAK_TIMEOUT_MS = 25000;
const KOKORO_TIMEOUT_MS = 90000;
// 数据目录里那个子目录的名字。用插件 id（清单里的 id），不用显示名。
//
// 为什么不用显示名「本地语音朗读」：espeak-ng 的 dll 打开数据文件时用的是窄字符
// 接口，路径里只要有非 ASCII 字符就找不到文件，服务直接起不来（实测：同一个
// 环境目录，叫 kokoro2 能起，叫 本地语音朗读 就报 “Error processing file
// .../phontab”）。插件 id 是 ASCII，用户名目录也可能带中文，所以整条路径都必须是 ASCII。
const DATA_DIR_NAME = "hana-local-tts";
const KOKORO_DEFAULT_VOICE = "zf_094";
const KOKORO_VOICE_IDS = new Set(KOKORO_VOICES.map((item) => item.id));
const PROVIDER_ID = "hana-local-tts";
const PROTOCOL_ID = "hana-local-tts-sapi";
const ADAPTER_ID = "hana-local-tts-speech";
const MODEL_ID = "windows";

let speechProviderError = "";
let systemVoiceCache = [];

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function quotePs(value) {
  return String(value).replaceAll("'", "''");
}

function clampRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(2, Math.max(0.5, Math.round(number * 10) / 10));
}

function sapiRate(multiplier) {
  return Math.round(Math.log2(clampRate(multiplier)) * 10);
}

function buildScript(textFile, wavFile, voice, rate, preferChinese, play = true) {
  const prefer = preferChinese ? "$true" : "$false";
  const player = play
    ? `$player = New-Object System.Media.SoundPlayer '${quotePs(wavFile)}'
  $player.PlaySync()
  $player.Dispose()`
    : "";
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $text = [System.IO.File]::ReadAllText('${quotePs(textFile)}', [System.Text.Encoding]::UTF8)
  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled })
  if ($voices.Count -eq 0) { throw '没有可用的系统语音。' }
  $picked = $voices | Where-Object { $_.VoiceInfo.Name -eq '${quotePs(voice)}' } | Select-Object -First 1
  if (-not $picked -and ${prefer}) {
    $picked = $voices | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
  }
  if (-not $picked) { $picked = $voices | Select-Object -First 1 }
  $synth.SelectVoice($picked.VoiceInfo.Name)
  $synth.Rate = ${sapiRate(rate)}
  $synth.SetOutputToWaveFile('${quotePs(wavFile)}')
  $synth.Speak($text)
  $synth.SetOutputToNull()
  ${player}
} finally {
  $synth.Dispose()
}
`.trim();
}

const LIST_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled })
  foreach ($item in $voices) {
    Write-Output ($item.VoiceInfo.Name + [char]9 + $item.VoiceInfo.Culture.Name)
  }
} finally {
  $synth.Dispose()
}
`.trim();

function runPowerShell(executable, script, timeout = SPEAK_TIMEOUT_MS) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          error.stdout = stdout;
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout || "") });
      },
    );
  });
}

function parseVoices(stdout) {
  return stdout.split(/\r?\n/).map((line) => {
    const tab = line.indexOf("\t");
    if (tab <= 0) return null;
    const name = line.slice(0, tab).trim();
    const culture = line.slice(tab + 1).trim();
    if (!name) return null;
    return { name, culture };
  }).filter(Boolean);
}

async function logRouteError(sdk, label, error) {
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

function errorDetail(error) {
  const parts = [
    error && error.code,
    error && error.permission,
    error && error.resource,
    error && error.message,
    error && error.stack ? String(error.stack).split("\n").slice(0, 3).join(" | ") : "",
  ].filter(Boolean);
  return parts.join(" · ").slice(0, 600);
}

function failureText(error, label = "朗读失败") {
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

async function powershellPath(sdk) {
  const executable = await sdk.process.resolveExecutable({ candidates: ["powershell.exe", "powershell"] });
  return executable ? executable.path : "";
}

async function listVoices(sdk) {
  const executable = await powershellPath(sdk);
  if (!executable) return [];
  const { stdout } = await runPowerShell(executable, LIST_SCRIPT);
  return parseVoices(stdout);
}

// 没选数据目录时，给用户一个建议的起点：文档文件夹。
function defaultKokoroRoot() {
  return path.join(os.homedir(), "Documents");
}

// 数据目录名：跟清单里的插件 id 一致。用插件 id 而不是显示名：显示名是中文，
// 而 espeak-ng 的 dll 处理不了非 ASCII 路径（见 DATA_DIR_NAME 那条注释）。
let dataDirName = DATA_DIR_NAME;
try {
  const manifest = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "manifest.json"), "utf8"));
  if (typeof manifest.id === "string" && /^[A-Za-z0-9._-]+$/.test(manifest.id)) dataDirName = manifest.id;
} catch {
  // 读不到清单就用写死的那个。
}

// 用户挑了文件夹之后，App 在里面建一个自己的子目录，模型和运行环境都放那儿。
function dataDirUnder(picked) {
  return path.join(picked, dataDirName);
}

async function kokoroStatus(sdk) {
  const root = await kokoroRoot(sdk);
  const result = { installed: false, modelReady: false, cpuReady: false, gpuReady: false, dirGB: null, running: false, foreign: false, device: "", serviceRoot: "", path: root, defaultPath: defaultKokoroRoot(), autoStop: await autoStopEnabled(sdk), targetDevice: await kokoroDevice(sdk), probeFailed: false, probeError: "", modelName: "", modelBytes: 0, cpuName: "", cpuBytes: 0, gpuName: "", gpuBytes: 0, needPath: !root };
  // Python 那一行不用助手：机器上可能一个 Python 都没有，助手跑不起来。
  const portable = await portablePythonState(sdk, sdk.dataDir);
  result.pythonReady = portable.ready === true;
  result.pythonVersion = portable.version || "";
  result.pythonSource = await pythonSource(sdk);
  result.pythonDownloading = portable.downloading === true;
  // 还没选数据目录：没什么可探测的，先让用户去选。
  if (!root) {
    await sdk.logger.info("kokoro status: no data directory chosen yet");
    return result;
  }
  try {
    const parsed = await runKokoroHelper(sdk, ["probe", "--root", root], { timeoutMs: 30000 });
    result.modelReady = parsed.model === true;
    result.cpuReady = parsed.cpu === true;
    result.gpuReady = parsed.gpu === true;
    if (typeof parsed.dirGB === "number") result.dirGB = parsed.dirGB;
    // 三份各自的名字和大小，设置页显示「已下载（名字 大小）」。
    if (typeof parsed.modelName === "string") result.modelName = parsed.modelName;
    if (typeof parsed.modelBytes === "number") result.modelBytes = parsed.modelBytes;
    if (typeof parsed.cpuName === "string") result.cpuName = parsed.cpuName;
    if (typeof parsed.cpuBytes === "number") result.cpuBytes = parsed.cpuBytes;
    if (typeof parsed.gpuName === "string") result.gpuName = parsed.gpuName;
    if (typeof parsed.gpuBytes === "number") result.gpuBytes = parsed.gpuBytes;
    result.running = parsed.running === true;
    result.foreign = parsed.foreign === true;
    if (typeof parsed.device === "string") result.device = parsed.device;
    if (typeof parsed.serviceRoot === "string") result.serviceRoot = parsed.serviceRoot;
  } catch (error) {
    // 探测失败和“真的没装”是两回事，页面要分开说。
    result.probeFailed = true;
    result.probeError = failureText(error, "读不到状态");
    await sdk.logger.error(`kokoro status check failed: ${errorDetail(error)}`);
  }
  result.installed = result.modelReady && (result.targetDevice === "cuda" ? result.gpuReady : result.cpuReady);
  if (result.probeFailed && !result.pythonReady) {
    // 一个 Python 都没有时，助手跑不了是正常的：先装 Python。
    result.probeError = "这台电脑还没有能用的 Python 3.12，先装一个。";
  }
  await sdk.logger.info(`kokoro status: model=${result.modelReady} cpu=${result.cpuReady} gpu=${result.gpuReady} installed=${result.installed} running=${result.running} device=${result.device || "-"} python=${result.pythonVersion || "-"}`);
  return result;
}

// 只在用户点 GPU「下载」时查显卡。不在打开设置时查，避免 nvidia-smi 弹出命令行窗口。
async function checkGpuHardware(sdk) {
  try {
    const result = await runKokoroHelper(sdk, ["gpu"], { timeoutMs: 45000 });
    if (result && result.gpu === true) return { ok: true };
    return { ok: false, error: "这台电脑没有 NVIDIA 显卡。" };
  } catch (error) {
    return { ok: false, error: failureText(error, "显卡检查失败") };
  }
}

async function readSpeechPrefs(sdk) {
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

// 宿主「多媒体 → 语音合成」里真正生效的那份设置：模型、声音、语速。
// M6 之后声音和语速归宿主管，App 自己 config 里那份已经是陈旧值，面板要显示宿主这份。
async function readHostSpeechPrefs(sdk) {
  const executable = await powershellPath(sdk);
  if (!executable) return null;
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }
$p = Join-Path (Join-Path (Join-Path $homeDir '.hanako') 'user') 'preferences.json'
$j = Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json
$sg = $j.speechGeneration
$id = [string]$sg.defaultSpeechModel.id
$mode = $sg.providerDefaults.'hana-local-tts'.models.$id.modes.text2speech
$result = @{ modelId = $id; speed = $null; voice = '' }
if ($null -ne $mode) {
  if ($null -ne $mode.speed) { $result.speed = [string]$mode.speed }
  if ($null -ne $mode.voice) { $result.voice = [string]$mode.voice }
}
$result | ConvertTo-Json -Compress
`.trim();
  try {
    const { stdout } = await runPowerShell(executable, script, 15000);
    const parsed = JSON.parse(String(stdout || "").trim());
    if (!parsed || !parsed.modelId) return null;
    const modelId = String(parsed.modelId);
    const voice = typeof parsed.voice === "string" ? parsed.voice : "";
    const speed = typeof parsed.speed === "string" || typeof parsed.speed === "number"
      ? clampRate(parsed.speed)
      : 1;
    return {
      modelId,
      engine: modelId === "kokoro" ? "kokoro" : "system",
      voice: modelId === "kokoro" ? "" : voice,
      rate: speed,
      kokoroVoice: modelId === "kokoro" ? kokoroVoiceId(voice) : KOKORO_DEFAULT_VOICE,
    };
  } catch (error) {
    await sdk.logger.error(`host speech prefs unavailable: ${failureText(error)}`);
    return null;
  }
}

function cleanInstallPath(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  const normalized = text.replace(/\/+$/, "").replace(/["']/g, "");
  return /^[A-Za-z]:[\\\/].+/.test(normalized) ? normalized : "";
}

// 整条路径都必须是 ASCII：espeak-ng 的 dll 打开数据文件时用窄字符接口，
// 路径里有中文就找不到文件（“Error processing file .../phontab”），服务直接起不来。
function hasNonAscii(text) {
  return /[^\x00-\x7F]/.test(String(text || ""));
}

// 数据目录：用户在设置页里挑的。没挑过就是空串——不猜，也不写死某个本机路径。
async function kokoroRoot(sdk) {
  try {
    const all = await sdk.config.getAll();
    return cleanInstallPath(all && all.kokoroRoot);
  } catch {
    return "";
  }
}

function kokoroVoiceId(value) {
  return typeof value === "string" && KOKORO_VOICE_IDS.has(value) ? value : KOKORO_DEFAULT_VOICE;
}

// 声音文件按需补下：换声音时只下那一个（约 0.5MB）。已经确认过的记在内存里，
// 不重复问助手；合成失败时清掉，下次重新确认，声音文件被删了也能自愈。
const readyVoices = new Set();

// 装模型时带哪个声音：宿主多媒体里选的那个，读不到就用 App 自己存的、再读不到用默认。
async function currentKokoroVoice(sdk) {
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

async function writeSpeechFile(sdk, text, voice, rate, wavFile, engine, play = true) {
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

// 只播放已经合好的 wav，不再合成。
async function playWavFile(sdk, wavFile) {
  const executable = await powershellPath(sdk);
  if (!executable) throw new Error("找不到 Windows PowerShell，没法把声音放出来。");
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$player = New-Object System.Media.SoundPlayer '${quotePs(wavFile)}'
$player.PlaySync()
$player.Dispose()
`.trim();
  await runPowerShell(executable, script, KOKORO_TIMEOUT_MS);
}

// 按句子切段：中文句末标点、英文句号、换行都算一段结束。
// 太短的相邻段合并，避免一句一句合成拖慢整体。
const SEGMENT_SOFT_LIMIT = 220;
const SEGMENT_HARD_LIMIT = 320;

function splitIntoSegments(rawText) {
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

// 流水线播放：当前段在放的同时，后台已经在合下一段。
// 段间间隔 = 播放结束到下一段开始，只剩播放调用本身的启动开销，不再白等合成。
// 流水线播放剩余段：当前段在放的同时，后台已在合下一段。
// segments 不含已合好的第一段，所以 segments[0] 就是第二段。
async function playRemainingSegments(sdk, dir, segments, voice, speed, engine, total, firstFile) {
  const tempFile = () => path.join(dir, `speech-${randomBytes(8).toString("hex")}.wav`);
  const prepare = (text) => {
    const target = tempFile();
    return writeSpeechFile(sdk, text, voice, speed, target, engine, false).then(() => target);
  };

  // 第一段已在 firstFile 里。先把第二段的合成发出去，再播第一段。
  let currentFile = firstFile;
  let nextReady = segments.length > 0 ? prepare(segments[0]) : null;
  let playedIndex = 0;

  while (currentFile) {
    try {
      await playWavFile(sdk, currentFile);
      playedIndex += 1;
      await sdk.logger.info(`speech segment ${playedIndex}/${total} played`);
    } catch (error) {
      await sdk.logger.error(`speech segment ${playedIndex + 1}/${total} playback failed: ${failureText(error)}`);
      if (currentFile !== firstFile) await rm(currentFile, { force: true }).catch(() => {});
      return;
    }
    // 第一段是宿主的产物文件，不能删；后面的临时段用完就删
    if (currentFile !== firstFile) await rm(currentFile, { force: true }).catch(() => {});

    if (!nextReady) break;
    try {
      currentFile = await nextReady;
    } catch (error) {
      await sdk.logger.error(`speech segment ${playedIndex + 1}/${total} failed: ${failureText(error)}`);
      return;
    }
    // 下一段已就绪：立刻发出再下一段的合成，然后回去播它
    nextReady = segments.length > playedIndex ? prepare(segments[playedIndex]) : null;
  }
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

function speechModelSnapshot() {
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

async function registerSpeechProvider(sdk) {
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
        const name = `speech-${randomBytes(8).toString("hex")}.wav`;
        const taskId = typeof params?.taskId === "string" && params.taskId ? params.taskId : name;

        if (segments.length === 1) {
          // 单段也把播放放到后台。宿主给适配器 submit 的 RPC 只有 30 秒（APPS.md：普通 RPC
          // 超时默认 30 秒），而播放要按音频的真实长度等：140 个字要放 27 秒，
          // 同步等就必然超时，宿主会报「submit timed out」，用户只看到一句没头没尾的失败。
          // 多段那条路早就是后台流水播放，这里跟它保持一致。
          const firstFile = path.join(dir, name);
          await writeSpeechFile(sdk, segments[0], voice, speed, firstFile, engine, false);
          await sdk.logger.info(`speech provider wrote ${name} (1 segment)`);
          playRemainingSegments(sdk, dir, [], voice, speed, engine, 1, firstFile).catch(async (error) => {
            await sdk.logger.error(`speech playback failed: ${failureText(error)}`);
          });
          return { taskId, files: [name] };
        }

        // 多段：第一段合到返回文件（不播），立刻把第二段的合成发出去，再播第一段。
        // 这样宿主拿到音频的同时，后台已经在准备下一段，段间只差播放启动开销。
        const firstFile = path.join(dir, name);
        await writeSpeechFile(sdk, segments[0], voice, speed, firstFile, engine, false);
        const rest = segments.slice(1);
        await sdk.logger.info(`speech provider wrote ${name} (1/${segments.length} segments, ${rest.length} queued)`);
        playRemainingSegments(sdk, dir, rest, voice, speed, engine, segments.length, firstFile).catch(async (error) => {
          await sdk.logger.error(`speech segments failed: ${failureText(error)}`);
        });
        return { taskId, files: [name] };
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

// 宿主给语音任务的状态值是 done / failed（不是 completed）。判定要认这两个值。
function speechTaskFailed(task) {
  const status = task && typeof task.status === "string" ? task.status : "";
  return status === "failed" || status === "error";
}

function speechTaskDone(task) {
  const status = task && typeof task.status === "string" ? task.status : "";
  return status === "done" || status === "completed";
}

async function waitForSpeechTask(sdk, taskId) {
  const deadline = Date.now() + KOKORO_TIMEOUT_MS;
  let task = null;
  while (Date.now() < deadline) {
    task = await sdk.media.getTask(taskId);
    if (task && task.status && task.status !== "pending") return task;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return task;
}

function speedTypeError(error) {
  const message = `${error && error.message ? error.message : error}`;
  return message.includes("speech speed must be a finite number");
}






async function savedSpeed(sdk) {
  const executable = await powershellPath(sdk);
  if (!executable) return 1;
  const script = `
$ErrorActionPreference = 'Stop'
$homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }
$p = Join-Path (Join-Path (Join-Path $homeDir '.hanako') 'user') 'preferences.json'
$j = Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json
$sg = $j.speechGeneration
$id = [string]$sg.defaultSpeechModel.id
$s = $sg.providerDefaults.'hana-local-tts'.models.$id.modes.text2speech.speed
if ($null -eq $s) { '1' } else { [string]$s }
`.trim();
  try {
    const { stdout } = await runPowerShell(executable, script, 15000);
    return clampRate(stdout.trim());
  } catch {
    return 1;
  }
}

async function requestSpeech(sdk, text, speed) {
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
async function ensureKokoroReady(sdk) {
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

async function synthesize(sdk, text) {
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

const KOKORO_INSTALL_SOURCES = { modelscope: "modelscope", "hf-mirror": "hf-mirror", huggingface: "huggingface" };
const KOKORO_PIP_SOURCES = { tuna: "tuna", aliyun: "aliyun", pypi: "pypi" };
const KOKORO_TORCH_SOURCES = { pytorch: "pytorch", nju: "nju" };
let installStartedAt = 0;

async function readInstallState(sdk, root) {
  const state = { phase: "none", message: "", percent: null, error: null, component: "" };
  // 安装进度由 install.py 镜像一份到 App 数据目录（Node 读不到安装目录）。
  try {
    const text = await readFile(path.join(sdk.dataDir, "install-state.json"), "utf8");
    const parsed = JSON.parse(text);
    if (parsed) {
      if (typeof parsed.phase === "string") state.phase = parsed.phase;
      if (typeof parsed.message === "string") state.message = parsed.message;
      if (typeof parsed.percent === "number") state.percent = parsed.percent;
      if (typeof parsed.error === "string") state.error = parsed.error;
      if (typeof parsed.component === "string") state.component = parsed.component;
    }
  } catch {
    // 状态文件读不到就当没安装过
  }
  return state;
}

async function startKokoroInstall(sdk, root, source, pipSource, torchSource, component, workDir, voice) {
  // 同一时刻只允许一个下载。上一件已经完成或失败时，可以接着下另一件。
  if (installStartedAt && Date.now() - installStartedAt < 30 * 60 * 1000) {
    const current = await readInstallState(sdk, root);
    if (current.phase !== "done" && current.phase !== "failed" && current.phase !== "none") {
      throw new Error("已有一次下载在进行中，请等它完成或失败后重试。");
    }
  }
  installStartedAt = Date.now();
  try {
    // Node 读不到用户选的安装目录，所以只把两份脚本放进 App 自己的数据目录，
    // 再让 Python 助手搬过去并启动（助手是子进程，不受 Node 权限模型限制）。
    const result = await startInstall(sdk, workDir, { root, component, source, pipSource, torchSource, voice, pythonSource: await pythonSource(sdk) });
    await sdk.logger.info(`kokoro install started root=${root} source=${source} component=${component} python=${result && result.python ? result.python : "-"}`);
    return { ok: true };
  } catch (error) {
    installStartedAt = 0;
    throw error;
  }
}

let watcherRunning = false;
let watcherChild = null;

// 「自动停止」开关的标记文件：守护进程看到它没了就不再停服务。
function autoStopFlagPath(sdk) {
  return path.join(sdk.dataDir, "kokoro-autostop.flag");
}

// 守护进程把自己的进程号写在这里，停了以后按它杀整棵树。
function watcherPidPath(sdk) {
  return path.join(sdk.dataDir, "kokoro-watch.pid");
}

// 找 Hana 桌面端的进程号（守护要盯着它）。
async function findHanaPid(sdk) {
  try {
    const result = await runKokoroHelper(sdk, ["hana-pid"], { timeoutMs: 20000 });
    const pid = result && Number(result.pid);
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

// 方案 A：把“这次 Hana 会话”的标记写进状态文件。
// App 启动时若发现 8765 在跑，但标记里的 Hana 进程已经不在了，说明是上次遗留，先停掉。
async function sessionMarkerPath(sdk) {
  return path.join(sdk.dataDir, "kokoro-session.json");
}

async function readSessionMarker(sdk) {
  try {
    const text = await readFile(await sessionMarkerPath(sdk), "utf8");
    const parsed = JSON.parse(text);
    return {
      hanaPid: typeof parsed.hanaPid === "number" ? parsed.hanaPid : null,
      watcherStartedAt: typeof parsed.watcherStartedAt === "number" ? parsed.watcherStartedAt : null,
    };
  } catch {
    return { hanaPid: null, watcherStartedAt: null };
  }
}

async function writeSessionMarker(sdk, hanaPid) {
  const file = await sessionMarkerPath(sdk);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ hanaPid, watcherStartedAt: Date.now() }), "utf8");
}

async function autoStopEnabled(sdk) {
  try {
    const all = await sdk.config.getAll();
    return all?.kokoroAutoStop !== false;
  } catch {
    return true;
  }
}

// 目标运行模式：cpu 或 cuda。没配置时用 cpu。
async function kokoroDevice(sdk) {
  try {
    const all = await sdk.config.getAll();
    return all?.kokoroDevice === "cuda" ? "cuda" : "cpu";
  } catch {
    return "cpu";
  }
}

// Python 来源：auto（默认，先用 App 自带的）、app（只用 App 自带的）、system（只用系统的）。
async function pythonSource(sdk) {
  try {
    const all = await sdk.config.getAll();
    const value = all?.kokoroPythonSource;
    return value === "app" || value === "system" ? value : "auto";
  } catch {
    return "auto";
  }
}

// 所有调助手的地方都走这里，Python 来源设置才能统一生效。
async function runKokoroHelper(sdk, args, options = {}) {
  const source = await pythonSource(sdk);
  return runHelper(sdk, sdk.dataDir, args, { ...options, source });
}

async function cleanupOrphanKokoro(sdk) {
  const marker = await readSessionMarker(sdk);
  if (!marker.hanaPid) return false;
  // 标记里的 Hana 进程还活着 → 不是遗留，不动
  try {
    const result = await runKokoroHelper(sdk, ["alive", "--pid", String(marker.hanaPid)], { timeoutMs: 15000 });
    if (result && result.alive === true) return false;
  } catch {
    return false;
  }
  // 上次的 Hana 已经不在了：若 8765 还在跑就是遗留，停掉
  const status = await kokoroStatus(sdk);
  if (status.running) {
    await sdk.logger.info("cleaning up orphan kokoro from previous session");
    await stopKokoroService(sdk);
    return true;
  }
  return false;
}

async function startKokoroService(sdk) {
  const root = await kokoroRoot(sdk);
  if (!root) throw new Error("还没选数据目录。先在设置页里点「浏览」选一个。");
  const device = await kokoroDevice(sdk);
  await syncServerCode(sdk, root);
  const result = await runKokoroHelper(sdk, ["start", "--root", root, "--device", device], { timeoutMs: 200000 });
  if (!result || result.running !== true) throw new Error("启动没有成功。");
  await ensureWatcher(sdk);
  return { ok: true };
}

// 把最新的 server.py 同步到安装目录：服务代码会随 App 升级，跑老代码容易出怪问题。
async function syncServerCode(sdk, root) {
  try {
    await writeAppSources(sdk.dataDir);
    await runKokoroHelper(sdk, ["sync", "--root", root, "--app-dir", sdk.dataDir], { timeoutMs: 20000 });
  } catch (error) {
    await sdk.logger.error(`kokoro source sync failed: ${failureText(error)}`);
  }
}

async function spawnKokoroService(sdk) {
  const root = await kokoroRoot(sdk);
  if (!root) throw new Error("还没选数据目录。先在设置页里点「浏览」选一个。");
  const device = await kokoroDevice(sdk);
  await syncServerCode(sdk, root);
  const result = await runKokoroHelper(sdk, ["start", "--root", root, "--device", device, "--wait", "0"], { timeoutMs: 30000 });
  if (!result || result.started !== true) throw new Error("启动没有成功。");
  await ensureWatcher(sdk);
  return { ok: true };
}

async function readKokoroLive(sdk) {
  try {
    const result = await runKokoroHelper(sdk, ["live"], { timeoutMs: 10000 });
    return { running: result && result.running === true, device: result && typeof result.device === "string" ? result.device : "" };
  } catch {
    return { running: false, device: "" };
  }
}

async function stopKokoroService(sdk, rootOverride) {
  // rootOverride：服务在别的目录跑的时候（比如换过安装路径），按它自己的目录找进程。
  const root = rootOverride || (await kokoroRoot(sdk));
  // 还没选过目录就没什么可停的。
  if (!root) return { ok: true, stopped: [] };
  const result = await runKokoroHelper(sdk, ["stop", "--root", root], { timeoutMs: 30000 });
  const stopped = result && Array.isArray(result.stopped) ? result.stopped : [];
  await sdk.logger.info(`kokoro stopped: ${stopped.join(",") || "none"}`);
  return { ok: true, stopped };
}

async function stopWatcher(sdk) {
  watcherRunning = false;
  // 守护进程看到开关被关掉就不再停服务（它自己会退出）。
  await rm(autoStopFlagPath(sdk), { force: true }).catch(() => {});
  // 旧版本留下的 PowerShell 守护脚本没用了，清掉。
  await rm(path.join(sdk.dataDir, "kokoro-watch.ps1"), { force: true }).catch(() => {});
  try {
    await runKokoroHelper(sdk, ["watch-stop", "--pid-file", watcherPidPath(sdk)], { timeoutMs: 20000 });
  } catch (error) {
    await sdk.logger.error(`kokoro watcher stop failed: ${failureText(error)}`);
  }
  watcherChild = null;
  await sdk.logger.info("kokoro watcher stopped");
  return 1;
}

async function ensureWatcher(sdk) {
  if (watcherRunning) return;
  if (!(await autoStopEnabled(sdk))) return;
  const root = await kokoroRoot(sdk);
  // 还没选数据目录：没服务要守。
  if (!root) return;
  const hanaPid = await findHanaPid(sdk);
  if (!hanaPid) return;
  // 开关文件：用户关掉「自动停止」时删掉它，守护进程就不再停服务。
  const flag = autoStopFlagPath(sdk);
  await mkdir(path.dirname(flag), { recursive: true });
  await writeFile(flag, String(hanaPid), "utf8");
  try {
    watcherChild = await spawnDetached(sdk, sdk.dataDir, [
      "watch",
      "--root", root,
      "--pid", String(hanaPid),
      "--flag", flag,
      "--pid-file", watcherPidPath(sdk),
    ]);
    watcherRunning = true;
    await writeSessionMarker(sdk, hanaPid);
    await sdk.logger.info("kokoro watcher started");
  } catch (error) {
    await sdk.logger.error(`kokoro watcher failed to start: ${failureText(error)}`);
  }
}

export default defineApp(async (sdk) => {
  await sdk.logger.info("hana-local-tts loaded");
  try {
    systemVoiceCache = await listVoices(sdk);
  } catch (error) {
    systemVoiceCache = [];
    await sdk.logger.error(`system voices unavailable: ${failureText(error)}`);
  }
  await registerSpeechProvider(sdk);
  // 方案 A：先清理上次遗留的服务，再拉守护进程（方案 B）
  await cleanupOrphanKokoro(sdk);
  await ensureWatcher(sdk);

  await sdk.routes.register((app) => {
    app.get("/probe", (c) => c.json({ ready: !speechProviderError, error: speechProviderError }));

    app.post("/probe", async (c) => {
      if (speechProviderError) return c.json({ ok: false, error: speechProviderError }, 500);
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
    app.post("/speak", async (c) => {
      if (speechProviderError) return c.json({ ok: false, error: speechProviderError }, 500);
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
          segments: splitIntoSegments(text).length,
        }, completed ? 200 : 500);
      } catch (error) {
        return c.json({ ok: false, error: failureText(error) }, 500);
      }
    });

    app.get("/kokoro-status", async (c) => {
      try {
        const status = await kokoroStatus(sdk);
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
      // 换目录前先把在跑的服务停掉：它占着 8765，而且加载的是旧目录里的模型。
      let stopped = [];
      try {
        const status = await kokoroStatus(sdk);
        if (status.running) {
          const target = status.serviceRoot || previous;
          if (target) {
            const result = await stopKokoroService(sdk, target);
            stopped = result.stopped || [];
            await sdk.logger.info(`kokoro stopped before path change: ${stopped.join(",") || "none"}`);
          }
        }
      } catch (error) {
        await sdk.logger.error(`kokoro stop before path change failed: ${failureText(error)}`);
      }
      try {
        await sdk.config.setMany({ kokoroRoot: root });
      } catch (error) {
        return c.json({ error: failureText(error) }, 500);
      }
      // 声音文件是按目录放的，换了目录要重新确认一遍。
      readyVoices.clear();
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
          // 另一个目录的服务占着 8765，先把它停掉再起自己的。
          await stopKokoroService(sdk, status.serviceRoot || (await kokoroRoot(sdk)));
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
        if (!status.running) return c.json({ ok: true, stopped: [] });
        // 服务可能在另一个目录（换过安装路径）。按它自己报的目录停，不误伤别的。
        const target = status.serviceRoot || (await kokoroRoot(sdk));
        const result = await stopKokoroService(sdk, target);
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
