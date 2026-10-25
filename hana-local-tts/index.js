import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineApp } from "./sdk/app-contract/server-client.js";

export const name = "hana-local-tts";

const MAX_CHARS = 800;
const SPEAK_TIMEOUT_MS = 25000;

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

function runPowerShell(executable, script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { timeout: SPEAK_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
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
    return { voice, rate };
  } catch {
    return { voice: "", rate: 1 };
  }
}

async function synthesize(sdk, text) {
  const executable = await powershellPath(sdk);
  if (!executable) return textResult("找不到 Windows PowerShell，没法用系统语音朗读。");

  const prefs = await readSpeechPrefs(sdk);
  const dir = path.join(sdk.dataDir, "speak", randomBytes(8).toString("hex"));
  const textFile = path.join(dir, "text.txt");
  const wavFile = path.join(dir, "speech.wav");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(textFile, text, "utf8");
    const preferChinese = /[\u4e00-\u9fff]/.test(text);
    await runPowerShell(executable, buildScript(textFile, wavFile, prefs.voice, prefs.rate, preferChinese));
    const wav = await readFile(wavFile);
    if (wav.length < 44 || wav.subarray(0, 4).toString("ascii") !== "RIFF") {
      return textResult("系统语音没有生成有效的音频。");
    }
    await sdk.logger.info(`speak ok bytes=${wav.length} voice=${prefs.voice || "auto"} rate=${prefs.rate}`);
    if (wav.length > 8 * 1024 * 1024) {
      return textResult("这段音频超过 8MB，Hana 放不了。请换短一点的消息。");
    }
    return {
      content: [{ type: "text", text: "已朗读。" }],
      details: { audio: { mimeType: "audio/wav", dataBase64: wav.toString("base64") } },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export default defineApp(async (sdk) => {
  await sdk.logger.info("hana-local-tts loaded");

  await sdk.routes.register((app) => {
    app.get("/voices", async (c) => {
      try {
        const voices = await listVoices(sdk);
        const prefs = await readSpeechPrefs(sdk);
        return c.json({ voices, ...prefs });
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
      if (voice.length > 120) return c.json({ error: "声音名称太长。" }, 400);
      try {
        await sdk.config.setMany({ voice, rate });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: message.slice(0, 180) }, 400);
      }
      return c.json({ ok: true, voice, rate });
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
