// Kokoro 本地模型管理：数据目录、状态探测、下载安装、服务启停、守护进程、临时清理。
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHelper, spawnDetached, startInstall, writeAppSources, portablePythonState } from "../kokoro-runtime.js";
import { KOKORO_VOICES } from "../kokoro-voices.js";
import { errorDetail, failureText } from "./errors.js";

// 数据目录里那个子目录的名字。用插件 id（清单里的 id），不用显示名。
//
// 为什么不用显示名「本地语音朗读」：espeak-ng 的 dll 打开数据文件时用的是窄字符
// 接口，路径里只要有非 ASCII 字符就找不到文件，服务直接起不来（实测：同一个
// 环境目录，叫 kokoro2 能起，叫 本地语音朗读 就报 “Error processing file
// .../phontab”）。插件 id 是 ASCII，用户名目录也可能带中文，所以整条路径都必须是 ASCII。
const DATA_DIR_NAME = "hana-local-tts";

export const KOKORO_DEFAULT_VOICE = "zf_094";
export const KOKORO_VOICE_IDS = new Set(KOKORO_VOICES.map((item) => item.id));

export function defaultKokoroRoot() {
  return path.join(os.homedir(), "Documents");
}

// 数据目录名：跟清单里的插件 id 一致。用插件 id 而不是显示名：显示名是中文，
// 而 espeak-ng 的 dll 处理不了非 ASCII 路径（见 DATA_DIR_NAME 那条注释）。
let dataDirName = DATA_DIR_NAME;
try {
  const manifest = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "manifest.json"), "utf8"));
  if (typeof manifest.id === "string" && /^[A-Za-z0-9._-]+$/.test(manifest.id)) dataDirName = manifest.id;
} catch {
  // 读不到清单就用写死的那个。
}

// 用户挑了文件夹之后，App 在里面建一个自己的子目录，模型和运行环境都放那儿。
export function dataDirUnder(picked) {
  return path.join(picked, dataDirName);
}

export async function kokoroStatus(sdk) {
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
export async function checkGpuHardware(sdk) {
  try {
    const result = await runKokoroHelper(sdk, ["gpu"], { timeoutMs: 45000 });
    if (result && result.gpu === true) return { ok: true };
    return { ok: false, error: "这台电脑没有 NVIDIA 显卡。" };
  } catch (error) {
    return { ok: false, error: failureText(error, "显卡检查失败") };
  }
}

export function cleanInstallPath(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  const normalized = text.replace(/\/+$/, "").replace(/["']/g, "");
  return /^[A-Za-z]:[\\\/].+/.test(normalized) ? normalized : "";
}

// 整条路径都必须是 ASCII：espeak-ng 的 dll 打开数据文件时用窄字符接口，
// 路径里有中文就找不到文件（“Error processing file .../phontab”），服务直接起不来。
export function hasNonAscii(text) {
  return /[^\x00-\x7F]/.test(String(text || ""));
}

// 数据目录：用户在设置页里挑的。没挑过就是空串——不猜，也不写死某个本机路径。
export async function kokoroRoot(sdk) {
  try {
    const all = await sdk.config.getAll();
    return cleanInstallPath(all && all.kokoroRoot);
  } catch {
    return "";
  }
}

// App 刚起来的时候，宿主还没把这个 App 的设置贡献挂上去，这时候读配置是空的
// （挂上去之前 getAll() 拿不到 kokoroRoot）。等它挂好再读。
//
// 不等会出事：以前 kokoroRoot() 有个写死的默认路径兜底，读不到配置也不影响；
// 去掉那个兜底之后，依赖配置的动作就会在每次重载后悄悄失效——“Hana 退出时
// 自动停服务”的守护进程起不来（实测：重载后 watcher 一直没起来，pid 文件里
// 的进程早没了，服务会在 Hana 退出后留在后台）。
export async function kokoroRootReady(sdk) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const root = await kokoroRoot(sdk);
    if (root) return root;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return "";
}

export function kokoroVoiceId(value) {
  return typeof value === "string" && KOKORO_VOICE_IDS.has(value) ? value : KOKORO_DEFAULT_VOICE;
}

export const KOKORO_INSTALL_SOURCES = { modelscope: "modelscope", "hf-mirror": "hf-mirror", huggingface: "huggingface" };
export const KOKORO_PIP_SOURCES = { tuna: "tuna", aliyun: "aliyun", pypi: "pypi" };
export const KOKORO_TORCH_SOURCES = { pytorch: "pytorch", nju: "nju" };

export async function readInstallState(sdk, root) {
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

export async function startKokoroInstall(sdk, root, source, pipSource, torchSource, component, workDir, voice) {
  // 同一时刻只允许一个下载。锁在数据目录的 install.lock 里，App 重载后仍然有效。
  // Node 读不到用户选的安装目录，所以只把脚本放进自己的数据目录，
  // 再让 Python 助手搬过去并启动（助手是子进程，不受 Node 权限模型限制）。
  const result = await startInstall(sdk, workDir, { root, component, source, pipSource, torchSource, voice, pythonSource: await pythonSource(sdk) });
  await sdk.logger.info(`kokoro install started root=${root} source=${source} component=${component} python=${result && result.python ? result.python : "-"}`);
  return { ok: true };
}

let watcherRunning = false;
let watcherChild = null;
let watcherStoppedAt = 0;
let watcherBackoffMs = 0;

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
export async function kokoroDevice(sdk) {
  try {
    const all = await sdk.config.getAll();
    return all?.kokoroDevice === "cuda" ? "cuda" : "cpu";
  } catch {
    return "cpu";
  }
}

// Python 来源：auto（默认，先用 App 自带的）、app（只用 App 自带的）、system（只用系统的）。
export async function pythonSource(sdk) {
  try {
    const all = await sdk.config.getAll();
    const value = all?.kokoroPythonSource;
    return value === "app" || value === "system" ? value : "auto";
  } catch {
    return "auto";
  }
}

// 本地服务的令牌。放在 App 自己的数据目录里，不进 Git，也不写进命令行。
const SERVICE_TOKEN_NAME = "kokoro-token.json";
const SERVICE_PORT = 8765;

async function ensureServiceTokenFile(dataDir) {
  const file = path.join(dataDir, SERVICE_TOKEN_NAME);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed.token === "string" && /^[a-f0-9]{64}$/.test(parsed.token)) return file;
  } catch {
    // 还没有，或内容坏了，下面重新生成。
  }
  const token = randomBytes(32).toString("hex");
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, JSON.stringify({ token, port: SERVICE_PORT }), "utf8");
  return file;
}

// 所有调助手的地方都走这里，Python 来源设置才能统一生效。
// 令牌文件路径一并带上。值本身留在文件里，进程列表里看不到。
export async function runKokoroHelper(sdk, args, options = {}) {
  const source = await pythonSource(sdk);
  const tokenFile = await ensureServiceTokenFile(sdk.dataDir);
  return runHelper(sdk, sdk.dataDir, [...args, "--token-file", tokenFile], { ...options, source });
}

// 中止正在进行的安装。助手负责核对进程、杀进程、写状态。
export async function cancelKokoroInstall(sdk, root, component) {
  const result = await runKokoroHelper(
    sdk,
    ["install-cancel", "--root", root, "--app-dir", sdk.dataDir, "--component", component],
    { timeoutMs: 60000 },
  );
  const cancelled = !!(result && result.cancelled);
  const reason = (result && result.reason) || "";
  await sdk.logger.info(
    `kokoro install cancel: ${cancelled ? "cancelled" : "not running"} pid=${result && result.pid ? result.pid : "-"} reason=${reason}`,
  );
  return { ok: true, cancelled, reason: (result && result.reason) || "" };
}

export async function cleanupOrphanKokoro(sdk) {
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

export async function startKokoroService(sdk) {
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

export async function spawnKokoroService(sdk) {
  const root = await kokoroRoot(sdk);
  if (!root) throw new Error("还没选数据目录。先在设置页里点「浏览」选一个。");
  const device = await kokoroDevice(sdk);
  await syncServerCode(sdk, root);
  const result = await runKokoroHelper(sdk, ["start", "--root", root, "--device", device, "--wait", "0"], { timeoutMs: 30000 });
  if (!result || result.started !== true) throw new Error("启动没有成功。");
  await ensureWatcher(sdk);
  return { ok: true };
}

export async function readKokoroLive(sdk) {
  try {
    const result = await runKokoroHelper(sdk, ["live"], { timeoutMs: 10000 });
    return { running: result && result.running === true, device: result && typeof result.device === "string" ? result.device : "" };
  } catch {
    return { running: false, device: "" };
  }
}

export async function stopKokoroService(sdk, rootOverride) {
  // rootOverride 只能是我们自己存过的数据目录，不能用 /health 报上来的目录。
  const root = rootOverride || (await kokoroRoot(sdk));
  // 还没选过目录就没什么可停的。
  if (!root) return { ok: true, stopped: [] };
  const result = await runKokoroHelper(sdk, ["stop", "--root", root], { timeoutMs: 30000 });
  const stopped = result && Array.isArray(result.stopped) ? result.stopped : [];
  await sdk.logger.info(`kokoro stopped: ${stopped.join(",") || "none"}`);
  return { ok: true, stopped };
}

export async function stopWatcher(sdk) {
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

// 定期清理临时目录。
//
// 服务每跑一次，phonemizer 会把 espeak-ng.dll 拷一份到 TEMP 里（Windows 上它的
// atexit 清理不生效），一次 419KB。起服务时会清上一轮的，但服务不重启就一直攒着，
// 所以这里再补一个定时清理。
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const CLEANUP_MAX_AGE_MINUTES = 60;
let cleanupTimer = null;

export async function cleanupTempDirs(sdk, waitForConfig = false) {
  const root = waitForConfig ? await kokoroRootReady(sdk) : await kokoroRoot(sdk);
  const dirs = [];
  if (root) dirs.push(path.join(root, "tmp"));
  dirs.push(path.join(sdk.dataDir, "tmp"));
  for (const dir of dirs) {
    try {
      const result = await runKokoroHelper(sdk, ["cleanup", "--temp-dir", dir, "--max-age-minutes", String(CLEANUP_MAX_AGE_MINUTES)], { timeoutMs: 60000 });
      if (result && result.removed > 0) {
        await sdk.logger.info(`cleaned ${result.removed} temp dirs (${result.freedBytes} bytes) in ${dir}`);
      }
    } catch (error) {
      await sdk.logger.warn(`temp cleanup failed for ${dir}: ${errorDetail(error)}`);
    }
  }
}

export function startCleanupLoop(sdk) {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    cleanupTempDirs(sdk).catch((error) => {
      sdk.logger.warn(`temp cleanup failed: ${errorDetail(error)}`);
    });
  }, CLEANUP_INTERVAL_MS);
  // 定时器不拖住进程：App 进程本来就由宿主管。
  if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();
}

// 等配置挂上来再拉守护进程。不阻塞 App 启动。
export async function ensureWatcherWhenReady(sdk) {
  await kokoroRootReady(sdk);
  try {
    await ensureWatcher(sdk);
  } catch (error) {
    await sdk.logger.error(`kokoro watcher failed to start: ${failureText(error)}`);
  }
}

export async function ensureWatcher(sdk) {
  if (watcherRunning) return;
  if (watcherBackoffMs && Date.now() - watcherStoppedAt < watcherBackoffMs) return;
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
  const tokenFile = await ensureServiceTokenFile(sdk.dataDir);
  try {
    const child = await spawnDetached(sdk, sdk.dataDir, [
      "watch",
      "--root", root,
      "--pid", String(hanaPid),
      "--flag", flag,
      "--pid-file", watcherPidPath(sdk),
      "--token-file", tokenFile,
    ]);
    const startedAt = Date.now();
    const clearWatcher = () => {
      if (watcherChild !== child) return;
      watcherChild = null;
      watcherRunning = false;
      watcherStoppedAt = Date.now();
      // 刚拉起来就退出，多半是句柄打不开。别每个状态刷新都再拉一次。
      watcherBackoffMs = Date.now() - startedAt < 2000 ? 60000 : 0;
    };
    child.on("exit", clearWatcher);
    child.on("error", clearWatcher);
    watcherChild = child;
    watcherRunning = true;
    watcherBackoffMs = 0;
    await writeSessionMarker(sdk, hanaPid);
    await sdk.logger.info("kokoro watcher started");
  } catch (error) {
    watcherRunning = false;
    await sdk.logger.error(`kokoro watcher failed to start: ${failureText(error)}`);
  }
}
