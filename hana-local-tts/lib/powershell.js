// PowerShell 调用层：SAPI 合成脚本、系统语音列表、宿主语音偏好读取、wav 播放。
import { execFile } from "node:child_process";
import { failureText } from "./errors.js";
import { KOKORO_DEFAULT_VOICE, kokoroVoiceId } from "./kokoro.js";

const SPEAK_TIMEOUT_MS = 25000;
export const KOKORO_TIMEOUT_MS = 90000;

export function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function quotePs(value) {
  return String(value).replaceAll("'", "''");
}

export function clampRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(2, Math.max(0.5, Math.round(number * 10) / 10));
}

function sapiRate(multiplier) {
  return Math.round(Math.log2(clampRate(multiplier)) * 10);
}

export function buildScript(textFile, wavFile, voice, rate, preferChinese, play = true) {
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

export function runPowerShell(executable, script, timeout = SPEAK_TIMEOUT_MS) {
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

export async function powershellPath(sdk) {
  const executable = await sdk.process.resolveExecutable({ candidates: ["powershell.exe", "powershell"] });
  return executable ? executable.path : "";
}

export async function listVoices(sdk) {
  const executable = await powershellPath(sdk);
  if (!executable) return [];
  const { stdout } = await runPowerShell(executable, LIST_SCRIPT);
  return parseVoices(stdout);
}

export async function readHostSpeechPrefs(sdk) {
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

export async function playWavFile(sdk, wavFile) {
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

export function speedTypeError(error) {
  const message = `${error && error.message ? error.message : error}`;
  return message.includes("speech speed must be a finite number");
}

export async function savedSpeed(sdk) {
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
