// Kokoro 运行时：Node 只做调度，碰盘和碰端口的活交给 spawn 出去的 Python 助手。
//
// 为什么不让 Node 自己干：App 进程受 Node 权限模型限制——只能读安装目录和自己的
// app-data，读不到用户目录（读 uv 目录直接 ERR_ACCESS_DENIED），也不能自己连
// 127.0.0.1。spawn 出去的子进程不受这套限制，所以磁盘和端口的活都走助手。
//
// 为什么不用 PowerShell：PowerShell 的报错是 CLIXML 格式，脚本又是拼在 JS 模板字符串
// 里的，反斜杠、环境变量、编码都踩过坑。Python 助手是纯文本输出，一行 JSON。
//
// 注意：Node 的权限模型对 fs 是「拒绝就抛异常」，不是「返回 false」。所有碰用户目录
// 的检查都必须包 try/catch，否则整个流程会被一个 existsSync 弄死。

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HELPER_PY_B64, INSTALL_PY_B64, SERVER_PY_B64 } from "./kokoro-files.js";

const execFileAsync = promisify(execFile);

export const PYTHON_VERSION = "3.12.14";
export const DOWNLOADED_DIR = "python";
const PY_LAUNCHER = "C:\\Windows\\py.exe";

// App 自带的便携版 Python（python-build-standalone，uv 用的同款）。
// 为什么不用官方安装包：3.12.11 之后官方只发源码没有 Windows 包；官方全量 zip
// 又缺 venvlauncher.exe，建不了 venv（实测）。这个包解压即用，pip/venv/VC 运行时全自带。
export const PORTABLE_PYTHON_VERSION = "3.12.16";
const PORTABLE_PYTHON_BUILD = "20261026";
const PORTABLE_PYTHON_ARCHIVE = `cpython-${PORTABLE_PYTHON_VERSION}+${PORTABLE_PYTHON_BUILD}-x86_64-pc-windows-msvc-install_only.tar.gz`;
const PORTABLE_PYTHON_URLS = [
  `https://registry.npmmirror.com/-/binary/python-build-standalone/${PORTABLE_PYTHON_BUILD}/${PORTABLE_PYTHON_ARCHIVE}`,
  `https://github.com/astral-sh/python-build-standalone/releases/download/${PORTABLE_PYTHON_BUILD}/${PORTABLE_PYTHON_ARCHIVE}`,
];
// 压缩包约 45MB，用来算进度条。
const PORTABLE_PYTHON_BYTES = 47100000;
const PORTABLE_PYTHON_STATE = "python-state.json";

// 宿主会清空子进程的环境变量，这里按需补齐，别让子进程依赖继承来的值。
export function childEnv(dataDir) {
  const home = os.homedir();
  const tmp = path.join(dataDir, "tmp");
  return {
    ...process.env,
    SystemRoot: process.env.SystemRoot || "C:\\Windows",
    PATH: process.env.PATH || "",
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    TEMP: tmp,
    TMP: tmp,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
}

export function helperSource() {
  return Buffer.from(HELPER_PY_B64, "base64").toString("utf8");
}

// existsSync 在权限模型下会抛异常，不是返回 false。
function safeExists(target) {
  try {
    return existsSync(target);
  } catch {
    return false;
  }
}

async function runCommand(executable, args, dataDir, timeoutMs = 20000) {
  const { stdout, stderr } = await execFileAsync(executable, args, {
    cwd: dataDir,
    env: childEnv(dataDir),
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: String(stdout || ""), stderr: String(stderr || "") };
}

async function resolveCommand(sdk, candidates) {
  try {
    const found = await sdk.process.resolveExecutable({ candidates });
    return found && found.path ? found.path : "";
  } catch {
    return "";
  }
}

// py 启动器列出的解释器：
//   -V:3.15 *        C:\...\Python315\python.exe
//   -V:Astral/CPython3.12.14 C:\...\uv\python\cpython-3.12.14-...\python.exe
// 返回标签和路径；标签决定怎么叫它（版本号用 -3.15，带厂商的用 -V:厂商/版本）。
export function parsePyList(stdout) {
  const found = [];
  const re = /-V:([^\s]+)\s+(?:\*\s+)?([A-Za-z]:\\.*?python\.exe)/g;
  let match;
  while ((match = re.exec(String(stdout || ""))) !== null) {
    const tag = match[1].trim();
    const exe = match[2].trim();
    if (tag && exe) found.push({ tag, exe });
  }
  return found;
}

export function selectorFor(tag) {
  return /^\d/.test(tag) ? `-${tag}` : `-V:${tag}`;
}

function isVersion312(tag) {
  return /3\.12/.test(tag);
}

async function pyLauncher(sdk, dataDir) {
  let launcher = await resolveCommand(sdk, ["py.exe", "py"]);
  if (!launcher) launcher = PY_LAUNCHER;
  let stdout = "";
  try {
    stdout = (await runCommand(launcher, ["-0p"], dataDir, 15000)).stdout;
  } catch {
    return { launcher: "", list: [] };
  }
  return { launcher, list: parsePyList(stdout) };
}

// 找一个能跑助手的解释器。顺序：
//   1. app-data 里自己下载的那份（读写都在允许范围内，最稳）
//   2. C:\Windows\py.exe 按标签拉起机器上已有的 Python
// 直接跑用户目录里的 python.exe 不行——那个路径 App 进程读不了。
// require312 为真时只认 3.12（装依赖、跑服务要用）。
// source：auto（默认，先用自带的）、app（只用自带的）、system（只用系统的）。
export async function resolveInterpreter(sdk, dataDir, require312, source = "auto") {
  const attempts = [];
  if (source !== "system") {
    const downloaded = path.join(dataDir, DOWNLOADED_DIR, "python.exe");
    if (safeExists(downloaded)) {
      const version = await pythonVersion(downloaded, [], dataDir);
      if (!require312 || (version && version.major === 3 && version.minor === 12)) {
        return { kind: "direct", command: downloaded, args: [], attempts };
      }
      attempts.push("app-data 里那份不是 3.12");
    } else {
      attempts.push("app-data 里没有 python");
    }
  }
  if (source === "app") {
    attempts.push("按设置只用 App 自带的 Python");
    return { kind: "none", attempts };
  }

  const { launcher, list } = await pyLauncher(sdk, dataDir);
  if (!launcher || !list.length) {
    attempts.push("py 启动器不可用或没有列出解释器");
    return { kind: "none", attempts };
  }
  const usable = require312 ? list.filter((item) => isVersion312(item.tag)) : list;
  if (!usable.length) {
    attempts.push("机器上没有 3.12");
    return { kind: "none", attempts };
  }
  const preferred = usable.find((item) => isVersion312(item.tag)) || usable[0];
  attempts.push(`用 py 启动器的 ${preferred.tag}`);
  return {
    kind: "launcher",
    command: launcher,
    args: [selectorFor(preferred.tag)],
    tag: preferred.tag,
    attempts,
  };
}

export async function findHelperPython(sdk, dataDir) {
  return resolveInterpreter(sdk, dataDir, false);
}

// 找 3.12 专用的解释器（装依赖、跑服务都要它）。
export async function findRuntimePython(sdk, dataDir) {
  return resolveInterpreter(sdk, dataDir, true);
}

export function parseVersion(text) {
  const match = String(text || "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), text: match[0] };
}

async function pythonVersion(executable, prefixArgs, dataDir) {
  try {
    const { stdout } = await runCommand(
      executable,
      [...prefixArgs, "-c", "import sys;print('%d.%d.%d' % sys.version_info[:3])"],
      dataDir,
      15000,
    );
    const text = stdout.trim().split(/\r?\n/).pop() || "";
    return parseVersion(text);
  } catch {
    return null;
  }
}

// 调助手的一个子命令，返回它打印的 JSON。
export async function runHelper(sdk, dataDir, args, options = {}) {
  const python = await resolveInterpreter(sdk, dataDir, false, options.source || "auto");
  if (python.kind === "none") {
    throw new Error(`找不到能用的 Python（${python.attempts.join("；")}）。需要 3.8 以上，3.12 最稳。`);
  }
  const { stdout, stderr } = await runCommand(
    python.command,
    [...python.args, "-c", helperSource(), ...args],
    dataDir,
    options.timeoutMs || 30000,
  );
  return parseHelperOutput(stdout, stderr);
}

// 找真正会用的那个 Python：App 自带的那份，还是系统里的。
export async function effectivePython(sdk, dataDir, source) {
  const python = await resolveInterpreter(sdk, dataDir, false, source || "auto");
  if (python.kind === "none") {
    return { ok: false, reason: python.attempts.join("；") };
  }
  const version = await pythonVersion(python.command, python.args, dataDir);
  return {
    ok: true,
    kind: python.kind,
    version: version ? version.text : "",
    path: python.command,
  };
}

// ---- App 自带的 Python ----

function pythonStatePath(dataDir) {
  return path.join(dataDir, PORTABLE_PYTHON_STATE);
}

export async function readPythonState(dataDir) {
  try {
    const parsed = JSON.parse(await readFile(pythonStatePath(dataDir), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writePythonState(dataDir, patch) {
  const next = { ...(await readPythonState(dataDir)), ...patch, updatedAt: Date.now() };
  try {
    await writeFile(pythonStatePath(dataDir), JSON.stringify(next), "utf8");
  } catch {
    // 状态写不进去也不影响下载本身。
  }
  return next;
}

// app-data 里那份 Python 的状态。这一步不用助手：机器上可能一个 Python 都没有，
// 助手（Python 脚本）跑不起来，状态还是得能显示。
export async function portablePythonState(sdk, dataDir) {
  const exe = path.join(dataDir, DOWNLOADED_DIR, "python.exe");
  const state = await readPythonState(dataDir);
  if (!safeExists(exe)) {
    return { ready: false, version: "", path: "", downloading: state.phase === "downloading", state };
  }
  const version = await pythonVersion(exe, [], dataDir);
  const ok = !!version && version.major === 3 && version.minor === 12;
  return {
    ready: ok,
    version: version ? version.text : "",
    path: ok ? exe : "",
    downloading: state.phase === "downloading",
    state,
  };
}

// 下载里的进度：看压缩包长了多少。
export async function pythonDownloadProgress(dataDir) {
  const state = await readPythonState(dataDir);
  if (state.phase !== "downloading") return { ...state, percent: state.percent || 0 };
  // 助手会报真进度；有就用它的，没有再拿压缩包大小估。
  if (typeof state.percent === "number" && state.percent > 0) return state;
  let bytes = 0;
  try {
    bytes = (await stat(path.join(dataDir, "tmp", "python.tar.gz"))).size;
  } catch {
    bytes = 0;
  }
  const total = state.total || PORTABLE_PYTHON_BYTES;
  return { ...state, bytes, percent: Math.min(99, Math.round((bytes * 100) / total)) };
}

// 下载并装好 App 自带的 Python。
// 这一步不能交给助手：助手本身就是 Python 脚本，机器上一个 Python 都没有时它跑不起来。
// 所以用系统自带的工具：curl.exe 下载（PowerShell 兵底），tar.exe 解压。
export async function startPythonDownload(sdk, dataDir) {
  const existing = await portablePythonState(sdk, dataDir);
  if (existing.ready) return { started: false, reason: "已经有了", version: existing.version };
  const state = await readPythonState(dataDir);
  if (state.phase === "downloading" || state.phase === "extracting") return { started: true, resumed: true };
  const tmp = path.join(dataDir, "tmp");
  await mkdir(tmp, { recursive: true });
  const archive = path.join(tmp, "python.tar.gz");
  await rm(archive, { force: true }).catch(() => {});
  await writePythonState(dataDir, {
    phase: "downloading",
    percent: 0,
    bytes: 0,
    total: PORTABLE_PYTHON_BYTES,
    message: `正在下载 Python ${PORTABLE_PYTHON_VERSION}…`,
    error: "",
  });
  // 有 Python 就让助手下（它的 urllib 稳），后台跑，不占着这次请求。
  const python = await resolveInterpreter(sdk, dataDir, false, "auto");
  if (python.kind !== "none") {
    await spawnDetached(sdk, dataDir, [
      "python-install",
      "--dir", path.join(dataDir, DOWNLOADED_DIR),
      "--state-dir", dataDir,
    ]);
    return { started: true, via: "helper" };
  }
  // 一个 Python 都没有：助手跑不起来，只能用系统自带的 curl.exe。
  runPythonDownload(sdk, dataDir, archive);
  return { started: true, via: "curl" };
}

async function runPythonDownload(sdk, dataDir, archive) {
  const curl = await resolveCommand(sdk, ["curl.exe", "curl"]);
  const shell = await resolveCommand(sdk, ["powershell.exe", "powershell"]);
  for (const url of PORTABLE_PYTHON_URLS) {
    await writePythonState(dataDir, { phase: "downloading", percent: 0, message: "正在下载 Python…" });
    let ok = false;
    if (curl) ok = await downloadWithCurl(sdk, dataDir, curl, url, archive);
    if (!ok && shell) ok = await downloadWithPowerShell(sdk, dataDir, shell, url, archive);
    if (ok) {
      await finishPythonInstall(sdk, dataDir, archive);
      return;
    }
    await writePythonState(dataDir, { phase: "retrying", percent: 0, message: "这个源没成，换一个…" });
  }
  await writePythonState(dataDir, { phase: "failed", percent: 0, message: "Python 没下成，两个源都不通。" });
}

// curl.exe 下载。失败返回 false，换下一个办法。
function downloadWithCurl(sdk, dataDir, curl, url, archive) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        curl,
        ["-L", "--fail", "--retry", "2", "--connect-timeout", "20", "-o", archive, url],
        { cwd: dataDir, env: childEnv(dataDir), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (error) {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

// PowerShell 的 Invoke-WebRequest 兵底。有些环境里 curl 的 TLS 凭据拿不到。
async function downloadWithPowerShell(sdk, dataDir, shell, url, archive) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' -OutFile '${archive.replace(/'/g, "''")}' -UseBasicParsing -TimeoutSec 1800`,
  ].join("\n");
  try {
    await runCommand(shell, ["-NoProfile", "-NonInteractive", "-Command", script], dataDir, 1800000);
    return true;
  } catch {
    return false;
  }
}

async function finishPythonInstall(sdk, dataDir, archive) {
  await writePythonState(dataDir, { phase: "extracting", percent: 95, message: "正在解压…" });
  const tar = await resolveCommand(sdk, ["tar.exe", "tar"]);
  if (!tar) {
    await writePythonState(dataDir, { phase: "failed", percent: 0, message: "找不到 Windows 自带的 tar.exe，解不开压缩包。" });
    return;
  }
  try {
    // 压缩包顶层就是 python/，解压到 app-data 里正好落在 app-data/python。
    await runCommand(tar, ["-xzf", archive, "-C", dataDir], dataDir, 300000);
  } catch (error) {
    await writePythonState(dataDir, { phase: "failed", percent: 0, message: `解压失败：${String((error && error.message) || error)}` });
    return;
  }
  const exe = path.join(dataDir, DOWNLOADED_DIR, "python.exe");
  const version = safeExists(exe) ? await pythonVersion(exe, [], dataDir) : null;
  if (!version || version.major !== 3 || version.minor !== 12) {
    await writePythonState(dataDir, { phase: "failed", percent: 0, message: "解压出来的 Python 版本不对。" });
    return;
  }
  await rm(archive, { force: true }).catch(() => {});
  await writePythonState(dataDir, {
    phase: "done",
    percent: 100,
    version: version.text,
    message: `Python ${version.text} 已经装好。`,
  });
}

// 把 server.py / install.py 放进 App 数据目录，助手会搬到安装目录再跑。
export async function writeAppSources(dataDir) {
  for (const [name, b64] of [["server.py", SERVER_PY_B64], ["install.py", INSTALL_PY_B64]]) {
    const target = path.join(dataDir, name);
    const wanted = Buffer.from(b64, "base64");
    try {
      const current = await readFile(target);
      if (current.equals(wanted)) continue;
    } catch {
      // 还没有这份文件，继续写。
    }
    await writeFile(target, wanted);
  }
}

// 发起一次安装：Node 只把文件放进自己的数据目录并叫助手去跑。
export async function startInstall(sdk, dataDir, options) {
  await writeAppSources(dataDir);
  // options.source 是模型下载源，Python 来源是另一个字段，别搞混。
  const python = await resolveInterpreter(sdk, dataDir, true, options.pythonSource || "auto");
  if (python.kind === "none") {
    throw new Error(
      options.pythonSource === "app"
        ? "App 自带的 Python 还没装好，先在上面「Python 运行环境」下载一个。"
        : `找不到 Python 3.12（${python.attempts.join("；")}）。装依赖和跑服务都要 3.12。`,
    );
  }
  const args = [
    ...python.args,
    "-c",
    helperSource(),
    "install",
    "--root", options.root,
    "--app-dir", dataDir,
    "--component", options.component,
    "--source", options.source,
    "--pip-source", options.pipSource,
    "--torch-source", options.torchSource,
  ];
  // 模型安装时带上当前选中的声音，只下那一个声音文件。
  if (options.component === "model" && options.voice) args.push("--voice", options.voice);
  const { stdout, stderr } = await runCommand(python.command, args, dataDir, 60000);
  return parseHelperOutput(stdout, stderr);
}

// 起一个后台常驻的助手进程（守护用）：脱离 App 生命周期，App 退出后它还活着。
//
// 不要用 detached: true。Windows 上 DETACHED_PROCESS 会给子进程单开一个控制台
// （CREATE_NO_WINDOW 会被忽略），就会闪一个黑窗口。实测：detached 拉起来的进程
// GetConsoleWindow() 不为 0；只用 windowsHide 才是 0（压根没控制台）。
// 普通 spawn 的子进程照样能活过父进程退出，够用。
export async function spawnDetached(sdk, dataDir, args) {
  const python = await resolveInterpreter(sdk, dataDir, false);
  if (python.kind === "none") {
    throw new Error(`找不到能用的 Python（${python.attempts.join("；")}）。`);
  }
  const child = spawn(python.command, [...python.args, "-c", helperSource(), ...args], {
    cwd: dataDir,
    env: childEnv(dataDir),
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

function parseHelperOutput(stdout, stderr) {
  const lines = String(stdout || "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) {
    throw new Error(String(stderr || "").trim() || "助手没有返回结果。");
  }
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    throw new Error("助手的输出不是 JSON：" + lines[lines.length - 1].slice(0, 120));
  }
}
