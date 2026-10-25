import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineApp } from "./sdk/app-contract/server-client.js";
import { KOKORO_VOICES } from "./kokoro-voices.js";

export const name = "hana-local-tts";

const MAX_CHARS = 800;
const SPEAK_TIMEOUT_MS = 25000;
const KOKORO_TIMEOUT_MS = 90000;
const KOKORO_ROOT = "D:\\ProgramData\\OH-WorkSpace\\hanako\\kokoro-zh";
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

function buildScript(textFile, wavFile, voice, rate, preferChinese) {
  const prefer = preferChinese ? "$true" : "$false";
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
  $player = New-Object System.Media.SoundPlayer '${quotePs(wavFile)}'
  $player.PlaySync()
  $player.Dispose()
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

function kokoroVoiceId(value) {
  return typeof value === "string" && KOKORO_VOICE_IDS.has(value) ? value : KOKORO_DEFAULT_VOICE;
}

function kokoroScript(textFile, wavFile, voice, rate) {
  const python = path.join(KOKORO_ROOT, ".venv", "Scripts", "python.exe");
  const server = path.join(KOKORO_ROOT, "server.py");
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
  Start-Process -FilePath '${quotePs(python)}' -ArgumentList '${quotePs(server)}' -WorkingDirectory '${quotePs(KOKORO_ROOT)}' -WindowStyle Hidden
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
$player = New-Object System.Media.SoundPlayer '${quotePs(wavFile)}'
$player.PlaySync()
$player.Dispose()
`.trim();
}

async function writeSpeechFile(sdk, text, voice, rate, wavFile, engine) {
  const executable = await powershellPath(sdk);
  if (!executable) throw new Error("找不到 Windows PowerShell，没法把声音放出来。");
  const textFile = `${wavFile}.txt`;
  if (engine === "kokoro") {
    await writeFile(textFile, text, "utf8");
    try {
      const kokoroVoice = kokoroVoiceId(voice);
      await runPowerShell(executable, kokoroScript(textFile, wavFile, kokoroVoice, rate), KOKORO_TIMEOUT_MS);
    } finally {
      await rm(textFile, { force: true });
    }
    return;
  }
  await writeFile(textFile, text, "utf8");
  try {
    const preferChinese = /[\u4e00-\u9fff]/.test(text);
    await runPowerShell(executable, buildScript(textFile, wavFile, voice, rate, preferChinese));
  } finally {
    await rm(textFile, { force: true });
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
        const name = `speech-${randomBytes(8).toString("hex")}.wav`;
        const modelId = String(params?.modelId || params?.model || "");
        const voice = params?.voice && params.voice !== "auto" ? String(params.voice) : "";
        await mkdir(dir, { recursive: true });
        await writeSpeechFile(sdk, Array.from(text).slice(0, MAX_CHARS).join(""), voice, clampRate(params?.speed), path.join(dir, name), modelId === "kokoro" ? "kokoro" : "system");
        await sdk.logger.info(`speech provider wrote ${name}`);
        return { taskId: typeof params?.taskId === "string" && params.taskId ? params.taskId : name, files: [name] };
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
      const text = chars.length > MAX_CHARS ? chars.slice(0, MAX_CHARS).join("") : raw;
      try {
        const result = await synthesize(sdk, text);
        if (chars.length > MAX_CHARS && result.details?.audio) {
          result.content = [{ type: "text", text: `只朗读了前 ${MAX_CHARS} 字。` }];
        }
        return result;
      } catch (error) {
        await sdk.logger.error(failureText(error));
        return textResult(failureText(error));
      }
    },
  });
});
