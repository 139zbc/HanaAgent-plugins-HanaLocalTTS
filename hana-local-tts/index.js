import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defineApp } from "./sdk/app-contract/server-client.js";
import { KOKORO_VOICES } from "./kokoro-voices.js";
import { INSTALL_PY_B64, SERVER_PY_B64 } from "./kokoro-files.js";
import { runHelper } from "./kokoro-runtime.js";

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
    if (error && error.kokoro) return "本地 Kokoro 没能在限定时间内启动或读完。请再点一次。";
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

function runtimePythonScript(root, device) {
  const folder = device === "cuda" ? ".venv-cuda" : ".venv-cpu";
  const expect = device === "cuda" ? "cuda" : "cpu";
  return `
function Get-TorchKind([string]$venv) {
  $marker = Join-Path $venv 'runtime.json'
  if (Test-Path -LiteralPath $marker) {
    try {
      $parsed = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($parsed.device -eq 'cuda' -or $parsed.device -eq 'cpu') { return [string]$parsed.device }
    } catch {}
  }
  $site = Join-Path (Join-Path $venv 'Lib') 'site-packages'
  if (-not (Test-Path -LiteralPath $site)) { return '' }
  $dist = @(Get-ChildItem -LiteralPath $site -Directory -Filter 'torch-*.dist-info' -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($dist.Count -eq 0) { return '' }
  if ($dist[0].Name -like '*+cu*') { return 'cuda' }
  return 'cpu'
}
$namedVenv = Join-Path '${quotePs(root)}' '${folder}'
$python = Join-Path (Join-Path $namedVenv 'Scripts') 'python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  $legacyVenv = Join-Path '${quotePs(root)}' '.venv'
  if ((Get-TorchKind $legacyVenv) -eq '${expect}') {
    $python = Join-Path (Join-Path $legacyVenv 'Scripts') 'python.exe'
  }
}
`.trim();
}

function defaultKokoroRoot() {
  return path.join(os.homedir(), ".hanako", "app-data", "hana-local-tts", "kokoro");
}

async function kokoroStatus(sdk) {
  const root = await kokoroRoot(sdk);
  const result = { installed: false, modelReady: false, cpuReady: false, gpuReady: false, dirGB: null, running: false, foreign: false, device: "", path: root, defaultPath: defaultKokoroRoot(), autoStop: await autoStopEnabled(sdk), targetDevice: await kokoroDevice(sdk), probeFailed: false, probeError: "" };
  try {
    const parsed = await runHelper(sdk, sdk.dataDir, ["probe", "--root", root], { timeoutMs: 30000 });
    result.modelReady = parsed.model === true;
    result.cpuReady = parsed.cpu === true;
    result.gpuReady = parsed.gpu === true;
    if (typeof parsed.dirGB === "number") result.dirGB = parsed.dirGB;
    result.running = parsed.running === true;
    result.foreign = parsed.foreign === true;
    if (typeof parsed.device === "string") result.device = parsed.device;
  } catch (error) {
    // 探测失败和“真的没装”是两回事，页面要分开说。
    result.probeFailed = true;
    result.probeError = failureText(error, "读不到状态");
    await sdk.logger.error(`kokoro status check failed: ${errorDetail(error)}`);
  }
  result.installed = result.modelReady && (result.targetDevice === "cuda" ? result.gpuReady : result.cpuReady);
  await sdk.logger.info(`kokoro status: model=${result.modelReady} cpu=${result.cpuReady} gpu=${result.gpuReady} installed=${result.installed} running=${result.running} device=${result.device || "-"}`);
  return result;
}

// 只在用户点 GPU「下载」时查显卡。不在打开设置时查，避免 nvidia-smi 弹出命令行窗口。
async function checkGpuHardware(sdk) {
  const executable = await powershellPath(sdk);
  if (!executable) return { ok: false, error: "找不到 Windows PowerShell。" };
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$smi = Join-Path (Join-Path $env:SystemRoot 'System32') 'nvidia-smi.exe'
$found = $false
if (Test-Path -LiteralPath $smi) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $smi
  $psi.Arguments = '--query-gpu=name --format=csv,noheader'
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $proc = [Diagnostics.Process]::Start($psi)
  $out = $proc.StandardOutput.ReadToEnd()
  $proc.WaitForExit()
  if ($out) { $found = $true }
}
if (-not $found) {
  $gpus = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*NVIDIA*' })
  if ($gpus.Count -gt 0) { $found = $true }
}
if ($found) { 'gpu-ok' } else { 'no-gpu' }
`.trim();
  try {
    const { stdout } = await runPowerShell(executable, script, 20000);
    return String(stdout || "").includes("gpu-ok") ? { ok: true } : { ok: false, error: "这台电脑没有 NVIDIA 显卡。" };
  } catch (error) {
    return { ok: false, error: failureText(error) };
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

function kokoroScript(root, textFile, wavFile, voice, rate, play = true, device = "cpu") {
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
${runtimePythonScript(root, device)}
${kokoroPidScript(root)}
${kokoroLaunchPrep(root)}
if (-not (Test-Kokoro)) {
  $existing = @(Get-KokoroPids $root)
  if ($existing.Count -eq 0) {
    if (-not (Test-Path -LiteralPath $python)) { throw '当前选择的运行环境未下载。' }
    $env:KOKORO_DEVICE = '${quotePs(device)}'
    Start-Process -FilePath $python -ArgumentList '${quotePs(server)}' -WorkingDirectory '${quotePs(root)}' -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $errLog
  }
  $deadline = (Get-Date).AddSeconds(180)
  do {
    Start-Sleep -Milliseconds 500
    if (Test-Kokoro) { break }
  } while ((Get-Date) -lt $deadline)
  if (-not (Test-Kokoro)) {
    $tail = ''
    foreach ($file in @($errLog, $log)) {
      if (Test-Path -LiteralPath $file) {
        $lines = @(Get-Content -LiteralPath $file -Tail 1 -ErrorAction SilentlyContinue)
        if ($lines.Count -gt 0 -and $lines[-1]) { $tail = [string]$lines[-1]; break }
      }
    }
    if ($tail) { throw ('本地 Kokoro 启动超时。' + $tail) } else { throw '本地 Kokoro 启动超时。请再点一次朗读。' }
  }
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
      try {
        await runPowerShell(executable, kokoroScript(root, textFile, wavFile, kokoroVoice, rate, play, await kokoroDevice(sdk)), 280000);
      } catch (error) {
        error.kokoro = true;
        throw error;
      }
      await ensureWatcher(sdk);
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

// 停止脚本：按端口找 PID，连子进程一起停。输出停掉的 PID 列表（base64）。
function kokoroPidScript(root) {
  return `
function Get-KokoroPids([string]$rootPath) {
  $needle = $rootPath.TrimEnd('\\').ToLower()
  $hits = New-Object System.Collections.Generic.List[int]
  $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue)
  foreach ($proc in $procs) {
    $cmd = [string]$proc.CommandLine
    if (-not $cmd) { continue }
    $folded = $cmd.ToLower()
    if ($folded.Contains('server.py') -and $folded.Contains($needle)) { [void]$hits.Add([int]$proc.ProcessId) }
  }
  return $hits
}
function Stop-PidTree([int[]]$seeds) {
  $all = New-Object System.Collections.Generic.HashSet[int]
  $queue = New-Object System.Collections.Generic.Queue[int]
  foreach ($seed in $seeds) { if (-not $all.Contains([int]$seed)) { [void]$all.Add([int]$seed); $queue.Enqueue([int]$seed) } }
  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $current" -ErrorAction SilentlyContinue)
    foreach ($child in $children) {
      $cid = [int]$child.ProcessId
      if (-not $all.Contains($cid)) { [void]$all.Add($cid); $queue.Enqueue($cid) }
    }
  }
  $stopped = @()
  foreach ($p in $all) {
    try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; $stopped += $p } catch {}
  }
  return $stopped
}
`.trim();
}

function kokoroLaunchPrep(root) {
  const quoted = quotePs(root);
  return `
$root = '${quoted}'
$log = Join-Path $root 'tmp\\server.log'
$errLog = Join-Path '${quoted}' 'tmp\\server.err'
New-Item -ItemType Directory -Force -Path (Join-Path '${quoted}' 'tmp') | Out-Null
$modelFile = Join-Path '${quoted}' 'hf-cache\\models--hexgrad--Kokoro-82M-v1.1-zh\\snapshots\\installed\\kokoro-v1_1-zh.pth'
if (Test-Path -LiteralPath $modelFile) { $env:HF_HUB_OFFLINE = '1' } else { Remove-Item Env:HF_HUB_OFFLINE -ErrorAction SilentlyContinue }
`.trim();
}

function kokoroStopScript(root) {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = '${quotePs(root)}'
${kokoroPidScript(root)}
$seeds = @(Get-KokoroPids $root)
if ($seeds.Count -eq 0) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('none')); exit }
$stopped = @(Stop-PidTree $seeds)
if ($stopped.Count -eq 0) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('none')); exit }
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($stopped -join ',')))
`.trim();
}

// 启动脚本：拉起 server.py，等健康检查通过。输出 ok。device 是目标模式（cpu/cuda）。
function kokoroStartScript(root, device) {
  const server = path.join(root, "server.py");
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Test-Kokoro {
  try {
    $health = Invoke-WebRequest -Uri 'http://127.0.0.1:${KOKORO_PORT}/health' -UseBasicParsing -TimeoutSec 2
    return $health.StatusCode -eq 200
  } catch { return $false }
}
${runtimePythonScript(root, device)}
${kokoroPidScript(root)}
${kokoroLaunchPrep(root)}
if (Test-Kokoro) { 'ok'; exit }
$existing = @(Get-KokoroPids $root)
if ($existing.Count -eq 0) {
  if (-not (Test-Path -LiteralPath $python)) { throw '当前选择的运行环境未下载。' }
  $env:KOKORO_DEVICE = '${quotePs(device)}'
  Start-Process -FilePath $python -ArgumentList '${quotePs(server)}' -WorkingDirectory '${quotePs(root)}' -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $errLog
}
$deadline = (Get-Date).AddSeconds(180)
do {
  Start-Sleep -Milliseconds 500
  if (Test-Kokoro) { break }
} while ((Get-Date) -lt $deadline)
if (-not (Test-Kokoro)) {
  $tail = ''
  foreach ($file in @($errLog, $log)) {
    if (Test-Path -LiteralPath $file) {
      $lines = @(Get-Content -LiteralPath $file -Tail 1 -ErrorAction SilentlyContinue)
      if ($lines.Count -gt 0 -and $lines[-1]) { $tail = [string]$lines[-1]; break }
    }
  }
  if ($tail) { throw ('启动超时。' + $tail) } else { throw '启动超时。' }
}
'ok'
`.trim();
}

// 守护脚本：盯住 Hana 主进程，它退出就停掉 Kokoro（连子进程一起停）。
// 由 App 用 Start-Process 拉起，独立于 Hana 生命周期。
function kokoroWatchScript(root) {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${kokoroPidScript(root)}
$watched = Get-Process HanaAgent -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $watched) { exit }
while ($true) {
  Start-Sleep -Seconds 5
  if (-not (Get-Process -Id $watched.Id -ErrorAction SilentlyContinue)) {
    $seeds = @(Get-KokoroPids '${quotePs(root)}')
    if ($seeds.Count -gt 0) { Stop-PidTree $seeds | Out-Null }
    exit
  }
}
`.trim();
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

async function synthesize(sdk, text) {
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
        if (typeof parsed.component === "string") state.component = parsed.component;
      }
    }
  } catch {
    // 状态文件读不到就当没安装过
  }
  return state;
}

function python312Script() {
  return `
$base = ''
$profileDir = [Environment]::GetFolderPath('UserProfile')
if (-not $profileDir) { $profileDir = $env:USERPROFILE }
$roots = New-Object System.Collections.Generic.List[string]
foreach ($item in @($env:APPDATA, $env:LOCALAPPDATA, [Environment]::GetFolderPath('ApplicationData'))) {
  if ($item) { [void]$roots.Add([string]$item) }
}
if ($profileDir) { [void]$roots.Add((Join-Path $profileDir 'AppData\\Roaming')) }
foreach ($r in $roots) {
  $uvRoot = Join-Path $r 'uv\\python'
  if (-not (Test-Path -LiteralPath $uvRoot)) { continue }
  $all = @(Get-ChildItem -LiteralPath $uvRoot -Directory -Filter 'cpython-3.12*' -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'python.exe') })
  if ($all.Count -eq 0) { continue }
  $exact = @($all | Where-Object { $_.Name -match '^cpython-3\\.12\\.\\d' } | Sort-Object Name -Descending)
  $pick = if ($exact.Count -gt 0) { $exact[0] } else { $all[0] }
  $base = Join-Path $pick.FullName 'python.exe'
  break
}
if (-not $base) {
  $pyCmd = Get-Command py -ErrorAction SilentlyContinue
  if ($pyCmd) {
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $listed = @(& py -0p 2>$null)
    $ErrorActionPreference = $oldPreference
    foreach ($row in $listed) {
      if ([string]$row -notmatch '3\\.12') { continue }
      $candidate = ([string]$row).Trim() -split '\\s+' | Select-Object -Last 1
      if ($candidate -and (Test-Path -LiteralPath $candidate)) { $base = $candidate; break }
    }
  }
}
if (-not $base -or -not (Test-Path -LiteralPath $base)) {
  $seen = ($roots | Select-Object -Unique) -join '; '
  throw "找不到 Python 3.12。需要 3.12 的任意小版本（推荐用 uv 安装）。已查找：$seen"
}
Write-Output "python=[$base]"
`.trim();
}

async function startKokoroInstall(sdk, root, source, pipSource, torchSource, component, workDir) {
  // 同一时刻只允许一个下载。上一件已经完成或失败时，可以接着下另一件。
  if (installStartedAt && Date.now() - installStartedAt < 30 * 60 * 1000) {
    const current = await readInstallState(sdk, root);
    if (current.phase !== "done" && current.phase !== "failed" && current.phase !== "none") {
      throw new Error("已有一次下载在进行中，请等它完成或失败后重试。");
    }
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
$diag = Join-Path $root 'tmp\\launch.log'
try {
  $serverB64 = (Get-Content -LiteralPath '${quotePs(serverB64File)}' -Raw).Trim()
  $installB64 = (Get-Content -LiteralPath '${quotePs(installB64File)}' -Raw).Trim()
  [IO.File]::WriteAllBytes((Join-Path $root 'server.py'), [Convert]::FromBase64String($serverB64))
  [IO.File]::WriteAllBytes((Join-Path $root 'install.py'), [Convert]::FromBase64String($installB64))
${python312Script()}
  $installer = Join-Path $root 'install.py'
  Start-Process -FilePath $base -ArgumentList @($installer, '--root', $root, '--source', '${quotePs(source)}', '--pip-source', '${quotePs(pipSource)}', '--torch-source', '${quotePs(torchSource)}', '--component', '${quotePs(component)}') -WorkingDirectory $root -WindowStyle Hidden
  'ok'
} catch {
  $detail = ($_ | Out-String)
  $nl = [Environment]::NewLine
  $env1 = "APPDATA=[$env:APPDATA] USERPROFILE=[$env:USERPROFILE] LOCALAPPDATA=[$env:LOCALAPPDATA]"
  $folder = [Environment]::GetFolderPath('ApplicationData')
  $text = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')$nl$env1$nlApplicationData=[$folder]$nl$detail"
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $diag) | Out-Null
    [IO.File]::WriteAllText($diag, $text, (New-Object Text.UTF8Encoding $false))
  } catch {}
  throw $detail
}
`.trim();
    const { stdout } = await runPowerShell(executable, script, 120000);
    if (!String(stdout || "").includes("ok")) throw new Error("安装进程没有启动。");
    await sdk.logger.info(`kokoro install started root=${root} source=${source} component=${component}`);
    return { ok: true };
  } catch (error) {
    installStartedAt = 0;
    throw error;
  }
}

let watcherRunning = false;

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

async function cleanupOrphanKokoro(sdk) {
  const marker = await readSessionMarker(sdk);
  if (!marker.hanaPid) return false;
  // 标记里的 Hana 进程还活着 → 不是遗留，不动
  const executable = await powershellPath(sdk);
  if (!executable) return false;
  const aliveScript = `
$ErrorActionPreference = 'Stop'
if (Get-Process -Id ${marker.hanaPid} -ErrorAction SilentlyContinue) { 'alive' } else { 'dead' }
`.trim();
  try {
    const { stdout } = await runPowerShell(executable, aliveScript, 15000);
    if (String(stdout || "").includes("alive")) return false;
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
  const executable = await powershellPath(sdk);
  if (!executable) throw new Error("找不到 Windows PowerShell。");
  const device = await kokoroDevice(sdk);
  const { stdout } = await runPowerShell(executable, kokoroStartScript(root, device), 200000);
  if (!String(stdout || "").includes("ok")) throw new Error("启动没有成功。");
  await ensureWatcher(sdk);
  return { ok: true };
}

// 只拉起进程，不等模型加载完。切换请求要马上返回，避免页面把慢启动当成失败。
function kokoroSpawnScript(root, device) {
  const server = path.join(root, "server.py");
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${runtimePythonScript(root, device)}
${kokoroPidScript(root)}
${kokoroLaunchPrep(root)}
$existing = @(Get-KokoroPids $root)
if ($existing.Count -eq 0) {
  if (-not (Test-Path -LiteralPath $python)) { throw '当前选择的运行环境未下载。' }
  $env:KOKORO_DEVICE = '${quotePs(device)}'
  Start-Process -FilePath $python -ArgumentList '${quotePs(server)}' -WorkingDirectory '${quotePs(root)}' -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $errLog
}
'spawned'
`.trim();
}

async function spawnKokoroService(sdk) {
  const root = await kokoroRoot(sdk);
  const executable = await powershellPath(sdk);
  if (!executable) throw new Error("找不到 Windows PowerShell。");
  const device = await kokoroDevice(sdk);
  const { stdout } = await runPowerShell(executable, kokoroSpawnScript(root, device), 20000);
  if (!String(stdout || "").includes("spawned")) throw new Error("启动没有成功。");
  await ensureWatcher(sdk);
  return { ok: true };
}

async function readKokoroLive(sdk) {
  const executable = await powershellPath(sdk);
  if (!executable) return { running: false, device: "" };
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $health = Invoke-WebRequest -Uri 'http://127.0.0.1:${KOKORO_PORT}/health' -UseBasicParsing -TimeoutSec 2
  if ($health.StatusCode -ne 200) { 'down'; exit }
  $parsed = $health.Content | ConvertFrom-Json
  if ($parsed.device -eq 'cuda') { 'cuda' } elseif ($parsed.device -eq 'cpu') { 'cpu' } else { 'up' }
} catch { 'down' }
`.trim();
  try {
    const { stdout } = await runPowerShell(executable, script, 8000);
    const text = String(stdout || "");
    if (text.includes("cuda")) return { running: true, device: "cuda" };
    if (text.includes("cpu")) return { running: true, device: "cpu" };
    return { running: false, device: "" };
  } catch {
    return { running: false, device: "" };
  }
}

async function stopKokoroService(sdk) {
  const executable = await powershellPath(sdk);
  if (!executable) throw new Error("找不到 Windows PowerShell。");
  const root = await kokoroRoot(sdk);
  const { stdout } = await runPowerShell(executable, kokoroStopScript(root), 30000);
  const b64 = String(stdout || "").trim().split(/\r?\n/).filter((line) => /^[A-Za-z0-9+/=]+$/.test(line.trim())).pop() || "";
  const stopped = b64 ? Buffer.from(b64, "base64").toString("utf8") : "none";
  await sdk.logger.info(`kokoro stopped: ${stopped}`);
  return { ok: true, stopped: stopped === "none" ? [] : stopped.split(",").filter(Boolean) };
}

async function stopWatcher(sdk) {
  const executable = await powershellPath(sdk);
  if (!executable) return;
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$watchers = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*kokoro-watch.ps1*' })
foreach ($w in $watchers) { Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue }
$watchers.Count
`.trim();
  try {
    const { stdout } = await runPowerShell(executable, script, 15000);
    watcherRunning = false;
    const count = Number(String(stdout || "").trim());
    await sdk.logger.info(`kokoro watcher stopped (${count})`);
    return count || 0;
  } catch (error) {
    await sdk.logger.error(`kokoro watcher stop failed: ${failureText(error)}`);
    return 0;
  }
}

async function ensureWatcher(sdk) {
  if (watcherRunning) return;
  if (!(await autoStopEnabled(sdk))) return;
  const executable = await powershellPath(sdk);
  if (!executable) return;
  // 先查一遍：App 重载后内存标志归零，但旧 watcher 可能还在跑，不重复拉
  const checkScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$existing = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*kokoro-watch.ps1*' })
"count=$($existing.Count)"
`.trim();
  try {
    const { stdout } = await runPowerShell(executable, checkScript, 15000);
    if (/count=[1-9]/.test(String(stdout || ""))) {
      watcherRunning = true;
      return;
    }
  } catch {
    // 查不到就继续尝试拉起
  }
  // watcher 脚本很长（base64 后超过命令行 32KB 上限），必须先写文件再用 -File 执行
  const scriptFile = path.join(sdk.dataDir, "kokoro-watch.ps1");
  await mkdir(path.dirname(scriptFile), { recursive: true });
  await writeFile(scriptFile, kokoroWatchScript(await kokoroRoot(sdk)), "utf8");
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$hana = Get-Process HanaAgent -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $hana) { 'no-hana'; exit }
Start-Process -FilePath '${quotePs(executable)}' -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', '${quotePs(scriptFile)}') -WindowStyle Hidden
"watcher-spawned $($hana.Id)"
`.trim();
  try {
    const { stdout } = await runPowerShell(executable, script, 15000);
    const text = String(stdout || "").trim();
    if (text.includes("no-hana")) return;
    watcherRunning = true;
    const pidMatch = text.match(/watcher-spawned (\d+)/);
    if (pidMatch) await writeSessionMarker(sdk, Number(pidMatch[1]));
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
        const result = await requestSpeech(sdk, "欢迎使用Hana Agent本地语音朗读 A P P");
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
        const root = cleanInstallPath(body && body.root) || (await kokoroRoot(sdk));
        await sdk.config.setMany({ kokoroRoot: root });
        const status = await kokoroStatus(sdk);
        if (component === "model" && status.modelReady) return c.json({ ok: false, error: "模型已经具备。" }, 400);
        if (component === "cpu" && status.cpuReady) return c.json({ ok: false, error: "CPU 运行环境已经具备。" }, 400);
        if (component === "gpu" && status.gpuReady) return c.json({ ok: false, error: "GPU 运行环境已经具备。" }, 400);
        if (component === "gpu") {
          const gpu = await checkGpuHardware(sdk);
          if (!gpu.ok) return c.json({ ok: false, error: gpu.error }, 400);
        }
        const result = await startKokoroInstall(sdk, root, source, pipSource, torchSource, component, sdk.dataDir);
        return c.json(result);
      } catch (error) {
        await logRouteError(sdk, "kokoro install failed", error);
        return c.json({ ok: false, error: failureText(error, "下载失败") }, 500);
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

    app.post("/kokoro-start", async (c) => {
      try {
        const status = await kokoroStatus(sdk);
        if (!status.modelReady) return c.json({ ok: false, error: "模型未下载。" }, 400);
        if (status.targetDevice === "cuda" && !status.gpuReady) return c.json({ ok: false, error: "GPU 运行环境未下载。" }, 400);
        if (status.targetDevice !== "cuda" && !status.cpuReady) return c.json({ ok: false, error: "CPU 运行环境未下载。" }, 400);
        if (status.running && !status.foreign) return c.json({ ok: true, alreadyRunning: true });
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
        if (status.foreign) return c.json({ ok: false, error: "服务是从另一个目录启动的，不能在这里停。" }, 400);
        const result = await stopKokoroService(sdk);
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
