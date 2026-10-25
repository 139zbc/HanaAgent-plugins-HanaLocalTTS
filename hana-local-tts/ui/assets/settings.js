import { hana } from "./sdk.js";

const probeStatus = document.getElementById("probe-status");
const probe = document.getElementById("probe");

probe.addEventListener("click", async () => {
  probe.disabled = true;
  probeStatus.textContent = "正在请宿主合成一句话…";
  try {
    const response = await hana.api.fetch("probe", { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || "合成没有走通。");
    probeStatus.textContent = "走通了。刚才那句是按多媒体里的默认模型和声音读的。";
  } catch (error) {
    probeStatus.textContent = error instanceof Error ? error.message : "合成没有走通。";
  } finally {
    probe.disabled = false;
  }
});

function setRow(id, state, text) {
  const element = document.getElementById(id);
  element.dataset.state = state;
  element.textContent = text;
}

// ---- 安装区 ----

const installSection = document.getElementById("install-section");
const installSource = document.getElementById("install-source");
const installRoot = document.getElementById("install-root");
const pathHint = document.getElementById("path-hint");
const installBtn = document.getElementById("install-btn");
const savePath = document.getElementById("save-path");
const progressWrap = document.getElementById("progress-wrap");
const progressFill = document.getElementById("progress-fill");
const progressMessage = document.getElementById("progress-message");
const installError = document.getElementById("install-error");

let pollTimer = null;
const ACTIVE_PHASES = new Set(["venv", "deps", "model", "verify"]);

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function showError(text) {
  installError.textContent = text;
  installError.hidden = !text;
}

function ensurePolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollInstall, 3000);
}

async function pollInstall() {
  try {
    const response = await hana.api.fetch("kokoro-install");
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error(body.error || "读不到安装进度。");
    if (body.phase === "none") {
      // 还没有状态文件：可能刚点完安装、进程还没写第一行，继续等
      return;
    }
    progressWrap.hidden = false;
    showError("");
    if (typeof body.percent === "number") progressFill.style.width = `${body.percent}%`;
    progressMessage.textContent = body.message || body.phase;
    if (body.phase === "done") {
      stopPolling();
      progressMessage.textContent = "安装完成。";
      setTimeout(() => location.reload(), 1500);
    } else if (body.phase === "failed") {
      stopPolling();
      installBtn.disabled = false;
      showError(body.message || "安装失败。");
    } else if (ACTIVE_PHASES.has(body.phase)) {
      // 进行中：保持按钮不可重复点，进度条持续跑
      installBtn.disabled = true;
    }
  } catch (error) {
    stopPolling();
    showError(error instanceof Error ? error.message : "读不到安装进度。");
  }
}

async function startInstall() {
  installBtn.disabled = true;
  showError("");
  try {
    const response = await hana.api.fetch("kokoro-install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: installSource.value, root: installRoot.value.trim() }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || "安装没有启动。");
    progressWrap.hidden = false;
    progressMessage.textContent = "安装已启动…";
    pollTimer = setInterval(pollInstall, 3000);
  } catch (error) {
    installBtn.disabled = false;
    showError(error instanceof Error ? error.message : "安装没有启动。");
  }
}

installBtn.addEventListener("click", startInstall);

savePath.addEventListener("click", async () => {
  savePath.disabled = true;
  try {
    const response = await hana.api.fetch("kokoro-path", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: installRoot.value.trim() }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || "路径没有保存。");
    showError("");
    installRoot.value = body.root;
    await loadKokoroStatus();
  } catch (error) {
    showError(error instanceof Error ? error.message : "路径没有保存。");
  } finally {
    savePath.disabled = false;
  }
});

// ---- 状态区 ----

async function loadKokoroStatus() {
  setRow("kokoro-installed", "loading", "正在查看…");
  setRow("kokoro-running", "loading", "正在查看…");
  setRow("kokoro-device", "loading", "正在查看…");
  document.getElementById("kokoro-path").textContent = "—";
  try {
    const response = await hana.api.fetch("kokoro-status");
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error(body.error || "读不到状态。");

    installRoot.value = body.path || body.defaultPath || "";

    setRow("kokoro-installed", body.installed ? "ok" : "bad",
      body.installed ? (typeof body.dirGB === "number" ? `已安装（约 ${body.dirGB} GB）` : "已安装") : "没有安装");
    document.getElementById("kokoro-path").textContent = body.path || "—";

    if (body.running) {
      setRow("kokoro-running", "ok", body.foreign ? "服务运行中（另一个目录）" : "服务运行中");
      if (body.device) {
        setRow("kokoro-device", "ok", body.device === "cuda" ? "GPU（显卡）" : "CPU");
      } else {
        setRow("kokoro-device", "loading", "服务没有上报运行模式");
      }
    } else {
      setRow("kokoro-running", "bad", "服务没有运行");
      setRow("kokoro-device", "loading", "服务没有运行时看不出");
    }

    if (!body.installed) {
      installSection.hidden = false;
      installRoot.placeholder = body.defaultPath || "D:\\models\\kokoro";
      // 恢复上次没装完的进度：先查一次，进行中就持续轮询
      const response = await hana.api.fetch("kokoro-install");
      const state = await response.json().catch(() => ({}));
      if (state && ACTIVE_PHASES.has(state.phase)) {
        ensurePolling();
        await pollInstall();
      } else if (state && state.phase === "failed") {
        progressWrap.hidden = false;
        if (typeof state.percent === "number") progressFill.style.width = `${state.percent}%`;
        progressMessage.textContent = state.message || "安装失败。";
        showError(state.message || "安装失败。");
        installBtn.disabled = false;
      }
    } else {
      installSection.hidden = true;
      progressWrap.hidden = true;
    }
  } catch (error) {
    setRow("kokoro-installed", "bad", "读不到状态");
    setRow("kokoro-running", "bad", "读不到状态");
    setRow("kokoro-device", "loading", error instanceof Error ? error.message : "读不到状态。");
  }
}

await hana.ready();

loadKokoroStatus();

try {
  const probeResponse = await hana.api.fetch("probe");
  const probeBody = await probeResponse.json();
  probeStatus.textContent = probeBody.ready
    ? "已注册。点「试一下合成」，听是不是按多媒体里的设置在读。"
    : (probeBody.error || "还没注册成语音供应商。");
  probe.disabled = !probeBody.ready;
} catch (error) {
  probeStatus.textContent = error instanceof Error ? error.message : "读不到供应商状态。";
  probe.disabled = true;
}
