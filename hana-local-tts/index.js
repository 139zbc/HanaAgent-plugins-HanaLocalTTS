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

function buildScript(textFile, wavFile, preferChinese) {
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
  $picked = $null
  if (${prefer}) {
    $picked = $voices | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
  }
  if (-not $picked) { $picked = $voices | Select-Object -First 1 }
  $synth.SelectVoice($picked.VoiceInfo.Name)
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
        resolve();
      },
    );
  });
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

async function synthesize(sdk, text) {
  const executable = await sdk.process.resolveExecutable({ candidates: ["powershell.exe", "powershell"] });
  if (!executable) return textResult("找不到 Windows PowerShell，没法用系统语音朗读。");

  const dir = path.join(sdk.dataDir, "speak", randomBytes(8).toString("hex"));
  const textFile = path.join(dir, "text.txt");
  const wavFile = path.join(dir, "speech.wav");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(textFile, text, "utf8");
    const preferChinese = /[\u4e00-\u9fff]/.test(text);
    await runPowerShell(executable.path, buildScript(textFile, wavFile, preferChinese));
    const wav = await readFile(wavFile);
    if (wav.length < 44 || wav.subarray(0, 4).toString("ascii") !== "RIFF") {
      return textResult("系统语音没有生成有效的音频。");
    }
    await sdk.logger.info(`speak ok bytes=${wav.length}`);
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
