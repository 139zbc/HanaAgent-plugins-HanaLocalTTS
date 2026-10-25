import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineApp } from "./sdk/app-contract/server-client.js";
import { KOKORO_VOICES } from "./kokoro-voices.js";
import { INSTALL_PY_B64, SERVER_PY_B64 } from "./kokoro-files.js";

export const name = "hana-local-tts";

const SPEECH_TEXT_MAX_BYTES = 32 * 1024; // 宿主的语音文本预算
const SPEAK_TIMEOUT_MS = 25000;
const KOKORO_TIMEOUT_MS = 90000;
const KOKORO_ROOT_DEFAULT = "D:\\ProgramData\\OH-WorkSpace\\hanako\\kokoro-zh";
const KOKORO_PORT = 8765;
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

function failureText(error) {
  const code = error && error.code;
  const raw = `${error && error.message ? error.message : error}\n${error && error.stderr ? error.stderr : ""}`;
  if (/app\/media\.provide/i.test(raw)) {
    return "还没有「提供媒体」权限。请在设置 → 应用能力里允许，然后重新加载这个 App。";
  }
  if (/app\/media\.generate/i.test(raw)) {
    return "还没有「生成媒体」权限。请在设置 → 应用能力里允许，然后重新加载这个 App。";
  }
  if (code === "ERR_ACCESS_DENIED" || /process\.spawn|APP_CAPABILITY_DENIED|EPERM/i.test(raw)) {
    return "还不能朗读。请在设置里允许这个 App 启动进程，然后重新加载它。";
  }
  if (code === "ETIMEDOUT" || /timed out/i.test(raw)) {
    return "这句话太长，系统语音没能在限定时间内读完。请换短一点的消息。";
  }
  const line = raw.split(/\r?\n/).map((item) => item.trim()).find((item) => item && !item.startsWith("#<") && !item.startsWith("<"));
  return `朗读失败：${(line || "系统语音没有返回音频。").slice(0, 180)}`;
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

function kokoroStatusScript(root) {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = '${quotePs(root)}'
$python = Join-Path $root '.venv\\Scripts\\python.exe'
$server = Join-Path $root 'server.py'
$model = Join-Path (Join-Path (Join-Path (Join-Path $root 'hf-cache') 'models--hexgrad--Kokoro-82M-v1.1-zh') 'snapshots') 'installed'
$model = Join-Path $model 'kokoro-v1_1-zh.pth'
$installed = (Test-Path -LiteralPath $python) -and (Test-Path -LiteralPath $server) -and (Test-Path -LiteralPath $model)
$dirGB = $null
if (Test-Path -LiteralPath $root) {
  $sum = (Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  if ($null -ne $sum) { $dirGB = [Math]::Round($sum / 1GB, 1) }
}
$running = $false
$device = ''
$servedRoot = ''
try {
  $health = Invoke-WebRequest -Uri 'http://127.0.0.1:${KOKORO_PORT}/health' -UseBasicParsing -TimeoutSec 2
  if ($health.StatusCode -eq 200) {
    $running = $true
    $parsed = $health.Content | ConvertFrom-Json
    $device = $parsed.device
    $servedRoot = $parsed.root
  }
} catch {}
# 服务在跑，但可能不是这个目录起的：对比服务自报的 root
$foreign = $false
if ($running -and $installed -and $servedRoot) {
  $a = [IO.Path]::GetFullPath($servedRoot).TrimEnd('\')
  $b = [IO.Path]::GetFullPath($root).TrimEnd('\')
  if ($a -ne $b) { $foreign = $true }
}
$result = @{ installed = $installed; dirGB = $dirGB; running = $running; device = $device; foreign = $foreign }
$result | ConvertTo-Json -Compress
`.trim();
}

async function defaultKokoroRoot(sdk) {
  const executable = await powershellPath(sdk);
  if (!executable) return "";
  const script = `
$ErrorActionPreference = 'Stop'
$d = Join-Path (Join-Path (Join-Path (Join-Path $env:USERPROFILE '.hanako') 'app-data') 'hana-local-tts') 'kokoro'
$d
`.trim();
  try {
    const { stdout } = await runPowerShell(executable, script, 15000);
    return String(stdout || "").trim();
  } catch {
    return "";
  }
}

async function kokoroStatus(sdk) {
  const root = await kokoroRoot(sdk);
  const result = { installed: false, dirGB: null, running: false, foreign: false, device: "", path: root, defaultPath: await defaultKokoroRoot(sdk) };
  const executable = await powershellPath(sdk);
  if (!executable) return result;
  try {
    const { stdout } = await runPowerShell(executable, kokoroStatusScript(root), 30000);
    const parsed = JSON.parse(String(stdout || "").trim());
    if (parsed) {
      result.installed = parsed.installed === true;
      if (typeof parsed.dirGB === "number") result.dirGB = parsed.dirGB;
      result.running = parsed.running === true;
      result.foreign = parsed.foreign === true;
      if (typeof parsed.device === "string") result.device = parsed.device;
    }
  } catch (error) {
    await sdk.logger.error(`kokoro status check failed: ${failureText(error)}`);
  }
  await sdk.logger.info(`kokoro status: installed=${result.installed} dirGB=${result.dirGB} running=${result.running} foreign=${result.foreign} device=${result.device || "-"}`);
  return result;
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

function cleanInstallPath(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  const normalized = text.replace(/\/+$/, "").replace(/["']/g, "");
  return /^[A-Za-z]:[\\\/].+/.test(normalized) ? normalized : "";
}

async function kokoroRoot(sdk) {
  try {
    const all = await sdk.config.getAll();
    return cleanInstallPath(all && all.kokoroRoot) || KOKORO_ROOT_DEFAULT;
  } catch {
    return KOKORO_ROOT_DEFAULT;
  }
}

function kokoroVoiceId(value) {
  return typeof value === "string" && KOKORO_VOICE_IDS.has(value) ? value : KOKORO_DEFAULT_VOICE;
}

function kokoroScript(root, textFile, wavFile, voice, rate, play = true) {
  const python = path.join(root, ".venv", "Scripts", "python.exe");
  const server = path.join(root, "server.py");
  const player = play
    ? `$player = New-Object System.Media.SoundPlayer '${quotePs(wavFile)}'
$player.PlaySync()
$player.Dispose()`
    : "";
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Test-Kokoro {
  try {
    $health = Invoke-WebRequest -Uri 'http://127.0.0.1:${KOKORO_PORT}/health' -UseBasicParsing -TimeoutSec 2
    return $health.StatusCode -eq 200
  } catch {
    return $false
  }
}
if (-not (Test-Kokoro)) {
  if (-not (Test-Path -LiteralPath '${quotePs(python)}')) { throw '找不到本地 Kokoro。' }
  Start-Process -FilePath '${quotePs(python)}' -ArgumentList '${quotePs(server)}' -WorkingDirectory '${quotePs(root)}' -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(80)
  do {
    Start-Sleep -Milliseconds 500
    if (Test-Kokoro) { break }
  } while ((Get-Date) -lt $deadline)
  if (-not (Test-Kokoro)) { throw '本地 Kokoro 启动超时。请再点一次朗读。' }
}
$text = [System.IO.File]::ReadAllText('${quotePs(textFile)}', [System.Text.Encoding]::UTF8)
$json = @{ input = $text.Trim(); voice = '${quotePs(voice)}'; speed = ${clampRate(rate)} } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
Invoke-WebRequest -Uri 'http://127.0.0.1:${KOKORO_PORT}/v1/audio/speech' -Method POST -ContentType 'application/json' -Body $bytes -OutFile '${quotePs(wavFile)}' -TimeoutSec 80
${player}
`.trim();
}

async function writeSpeechFile(sdk, text, voice, rate, wavFile, engine, play = true) {
  const executable = await powershellPath(sdk);
  if (!executable) throw new Error("找不到 Windows PowerShell，没法把声音放出来。");
  const textFile = `${wavFile}.txt`;
  if (engine === "kokoro") {
    await writeFile(textFile, text, "utf8");
    try {
      const kokoroVoice = kokoroVoiceId(voice);
      const root = await kokoroRoot(sdk);
      await runPowerShell(executable, kokoroScript(root, textFile, wavFile, kokoroVoice, rate, play), KOKORO_TIMEOUT_MS);
    } finally {
      await rm(textFile, { force: true });
    }
    return;
  }
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
            displayName: "本地 Kokoro",
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
          await writeSpeechFile(sdk, segments[0], voice, speed, path.join(dir, name), engine);
          await sdk.logger.info(`speech provider wrote ${name} (1 segment)`);
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
$p = Join-Path (Join-Path (Join-Path $env:USERPROFILE '.hanako') 'user') 'preferences.json'
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

async function synthesize(sdk, text) {
  const result = await requestSpeech(sdk, text);
  const taskId = result?.tasks?.[0]?.taskId;
  if (!taskId) return textResult("宿主没有返回语音任务。");
  const task = await waitForSpeechTask(sdk, taskId);
  if (task?.status !== "completed") {
    return textResult(task?.failReason || "语音任务没有在限定时间内完成。");
  }
  await sdk.logger.info(`speak ok task=${taskId}`);
  return textResult("已朗读。");
}

const KOKORO_INSTALL_SOURCES = { modelscope: "modelscope", "hf-mirror": "hf-mirror", huggingface: "huggingface" };
let installStartedAt = 0;

async function readInstallState(sdk, root) {
  const state = { phase: "none", message: "", percent: null, error: null };
  const executable = await powershellPath(sdk);
  if (!executable) return state;
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$p = Join-Path '${quotePs(root)}' 'install-state.json'
if (Test-Path -LiteralPath $p) {
  $text = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
}
`.trim();
  try {
    const { stdout } = await runPowerShell(executable, script, 15000);
    // 只取最后一行纯 base64，避开 PowerShell 的 CLIXML 进度噪声
    const b64 = String(stdout || "").trim().split(/\r?\n/).filter((line) => /^[A-Za-z0-9+/=]+$/.test(line.trim())).pop() || "";
    if (b64) {
      const text = Buffer.from(b64, "base64").toString("utf8");
      const parsed = JSON.parse(text);
      if (parsed) {
        if (typeof parsed.phase === "string") state.phase = parsed.phase;
        if (typeof parsed.message === "string") state.message = parsed.message;
        if (typeof parsed.percent === "number") state.percent = parsed.percent;
        if (typeof parsed.error === "string") state.error = parsed.error;
      }
    }
  } catch {
    // 状态文件读不到就当没安装过
  }
  return state;
}

async function startKokoroInstall(sdk, root, source, workDir) {
  // 同一时刻只允许一个安装；上次启动 30 分钟内不重复启动
  if (installStartedAt && Date.now() - installStartedAt < 30 * 60 * 1000) {
    throw new Error("已有一次安装在进行中，请等它完成或失败后重试。");
  }
  const executable = await powershellPath(sdk);
  if (!executable) throw new Error("找不到 Windows PowerShell。");
  installStartedAt = Date.now();
  try {
    // base64 太大，不能直接拼进命令行（会 ENAMETOOLONG），先写进 App 能写的临时目录
    const b64Dir = path.join(workDir, "install-b64");
    await mkdir(b64Dir, { recursive: true });
    const serverB64File = path.join(b64Dir, "server.b64");
    const installB64File = path.join(b64Dir, "install.b64");
    await writeFile(serverB64File, SERVER_PY_B64, "utf8");
    await writeFile(installB64File, INSTALL_PY_B64, "utf8");
    const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = '${quotePs(root)}'
New-Item -ItemType Directory -Force -Path $root | Out-Null
$serverB64 = (Get-Content -LiteralPath '${quotePs(serverB64File)}' -Raw).Trim()
$installB64 = (Get-Content -LiteralPath '${quotePs(installB64File)}' -Raw).Trim()
[IO.File]::WriteAllBytes((Join-Path $root 'server.py'), [Convert]::FromBase64String($serverB64))
[IO.File]::WriteAllBytes((Join-Path $root 'install.py'), [Convert]::FromBase64String($installB64))
$base = 'C:\\Users\\' + $env:USERNAME + '\\AppData\\Roaming\\uv\\python\\cpython-3.12.14-windows-x86_64-none\\python.exe'
if (-not (Test-Path -LiteralPath $base)) {
  $found = & py -V:Astral/CPython3.12.14 -c "import sys; print(sys.executable)" 2>$null
  if ($found) { $base = $found.Trim() }
}
if (-not (Test-Path -LiteralPath $base)) { throw '找不到 Python 3.12。请先安装 Python 3.12（推荐用 uv）。' }
$installer = Join-Path $root 'install.py'
Start-Process -FilePath $base -ArgumentList @($installer, '--root', $root, '--source', '${quotePs(source)}') -WorkingDirectory $root -WindowStyle Hidden
'ok'
`.trim();
    const { stdout } = await runPowerShell(executable, script, 120000);
    if (!String(stdout || "").includes("ok")) throw new Error("安装进程没有启动。");
    await sdk.logger.info(`kokoro install started root=${root} source=${source}`);
    return { ok: true };
  } catch (error) {
    installStartedAt = 0;
    throw error;
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

  await sdk.routes.register((app) => {
    app.get("/probe", (c) => c.json({ ready: !speechProviderError, error: speechProviderError }));

    app.post("/probe", async (c) => {
      if (speechProviderError) return c.json({ ok: false, error: speechProviderError }, 500);
      try {
        const result = await requestSpeech(sdk, "这是本地语音供应商测试。");
        const taskId = result?.tasks?.[0]?.taskId;
        if (!taskId) return c.json({ ok: false, error: "宿主没有返回语音任务。", result }, 500);
        const task = await waitForSpeechTask(sdk, taskId);
        const completed = task?.status === "completed";
        return c.json({
          ok: completed,
          error: completed ? "" : (task?.failReason || "语音任务没有在限定时间内完成。"),
          taskId,
          status: task?.status || "pending",
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

    app.post("/kokoro-install", async (c) => {
      let body;
      try {
        body = await c.req.json();
      } catch {
        body = null;
      }
      try {
        const source = KOKORO_INSTALL_SOURCES[body && body.source] || "modelscope";
        const root = cleanInstallPath(body && body.root) || (await kokoroRoot(sdk));
        const status = await kokoroStatus(sdk);
        if (status.installed) return c.json({ ok: false, error: "已经安装过了，不需要再装。" }, 400);
        await sdk.config.setMany({ kokoroRoot: root });
        const result = await startKokoroInstall(sdk, root, source, sdk.dataDir);
        return c.json(result);
      } catch (error) {
        return c.json({ ok: false, error: failureText(error) }, 500);
      }
    });

    app.put("/kokoro-path", async (c) => {
      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "请求不是 JSON。" }, 400);
      }
      const root = cleanInstallPath(body && body.root);
      if (!root) return c.json({ error: "路径要写完整盘符，例如 D:\\models\\kokoro。" }, 400);
      if (root.length > 160) return c.json({ error: "路径太长。" }, 400);
      try {
        await sdk.config.setMany({ kokoroRoot: root });
      } catch (error) {
        return c.json({ error: failureText(error) }, 500);
      }
      await sdk.logger.info(`kokoro root set to ${root}`);
      return c.json({ ok: true, root });
    });

    app.get("/voices", async (c) => {
      try {
        const voices = await listVoices(sdk);
        const prefs = await readSpeechPrefs(sdk);
        return c.json({ voices, kokoroVoices: KOKORO_VOICES, ...prefs });
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
