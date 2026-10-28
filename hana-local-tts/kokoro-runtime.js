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

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HELPER_PY_B64 } from "./kokoro-files.js";

const execFileAsync = promisify(execFile);

export const PYTHON_VERSION = "3.12.14";
const DOWNLOADED_DIR = "python";
const PY_LAUNCHER = "C:\\Windows\\py.exe";

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
export async function findHelperPython(sdk, dataDir) {
  const attempts = [];
  const downloaded = path.join(dataDir, DOWNLOADED_DIR, "python.exe");
  if (safeExists(downloaded)) {
    return { kind: "direct", command: downloaded, args: [], attempts };
  }
  attempts.push("app-data 里没有 python");

  const { launcher, list } = await pyLauncher(sdk, dataDir);
  if (!launcher || !list.length) {
    attempts.push("py 启动器不可用或没有列出解释器");
    return { kind: "none", attempts };
  }
  const preferred = list.find((item) => isVersion312(item.tag)) || list[0];
  attempts.push(`py 启动器可用，候选 ${list.map((item) => item.tag).join(", ")}`);
  return {
    kind: "launcher",
    command: launcher,
    args: [selectorFor(preferred.tag)],
    tag: preferred.tag,
    attempts,
  };
}

// 找 3.12 专用的解释器（装依赖、跑服务都要它）。
export async function findRuntimePython(sdk, dataDir) {
  const helper = await findHelperPython(sdk, dataDir);
  if (helper.kind === "none") return null;
  if (helper.kind === "direct") {
    const version = await pythonVersion(helper.command, helper.args, dataDir);
    if (version && version.major === 3 && version.minor === 12) return { ...helper, version };
    return null;
  }
  if (!isVersion312(helper.tag)) return null;
  const version = await pythonVersion(helper.command, helper.args, dataDir);
  if (version && version.major === 3 && version.minor === 12) return { ...helper, version };
  return null;
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
  const python = await findHelperPython(sdk, dataDir);
  if (python.kind === "none") {
    throw new Error(`找不到能用的 Python（${python.attempts.join("；")}）。需要 3.8 以上，3.12 最稳。`);
  }
  const { stdout, stderr } = await runCommand(
    python.command,
    [...python.args, "-c", helperSource(), ...args],
    dataDir,
    options.timeoutMs || 30000,
  );
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
