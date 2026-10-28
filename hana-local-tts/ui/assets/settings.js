import { hana } from "./sdk.js";
import { followHostTheme } from "./theme.js";

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

let openSelect = null;

function dressSelect(select) {
  const root = document.createElement("div");
  root.className = "tts-select" + (select.id === "device-select" ? " is-short" : "");
  select.parentNode.insertBefore(root, select);
  root.appendChild(select);
  select.classList.add("tts-select-native");

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "tts-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const value = document.createElement("span");
  value.className = "tts-select-value";
  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("viewBox", "0 0 16 16");
  chevron.setAttribute("aria-hidden", "true");
  chevron.classList.add("tts-select-chevron");
  chevron.innerHTML = '<path d="M4 6.2 8 10.2 12 6.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>';
  trigger.append(value, chevron);

  const popup = document.createElement("div");
  popup.className = "tts-select-popup";
  popup.hidden = true;
  popup.setAttribute("role", "listbox");
  root.append(trigger, popup);

  function labelOf(option) {
    return option ? option.textContent : "";
  }

  function sync() {
    const chosen = select.selectedOptions[0];
    value.textContent = labelOf(chosen);
    trigger.disabled = select.disabled;
    root.hidden = select.hidden;
    if (select.hidden || select.disabled) close();
  }

  function place() {
    const rect = trigger.getBoundingClientRect();
    popup.style.width = `${rect.width}px`;
    popup.style.left = `${rect.left}px`;
    const below = window.innerHeight - rect.bottom;
    if (below < 160 && rect.top > below) {
      popup.style.top = "auto";
      popup.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    } else {
      popup.style.bottom = "auto";
      popup.style.top = `${rect.bottom + 4}px`;
    }
  }

  function close() {
    popup.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (openSelect === close) openSelect = null;
  }

  function open() {
    if (openSelect && openSelect !== close) openSelect();
    popup.replaceChildren();
    for (const option of select.options) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "tts-select-option";
      item.setAttribute("role", "option");
      item.textContent = option.textContent;
      item.disabled = option.disabled;
      const selected = option.value === select.value;
      item.setAttribute("aria-selected", selected ? "true" : "false");
      item.addEventListener("click", () => {
        if (option.disabled) return;
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        sync();
        close();
      });
      popup.appendChild(item);
    }
    popup.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    place();
    openSelect = close;
  }

  trigger.addEventListener("click", () => {
    if (trigger.disabled) return;
    if (popup.hidden) open();
    else close();
  });
  select.addEventListener("change", sync);
  new MutationObserver(sync).observe(select, { attributes: true, attributeFilter: ["hidden", "disabled"] });
  document.addEventListener("pointerdown", (event) => {
    if (popup.hidden) return;
    if (root.contains(event.target) || popup.contains(event.target)) return;
    close();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  window.addEventListener("resize", () => { if (!popup.hidden) place(); });
  sync();
  return { sync };
}

// ---- 安装区 ----

const installSource = document.getElementById("install-source");
const pipSource = document.getElementById("pip-source");
const torchSource = document.getElementById("torch-source");
const installRoot = document.getElementById("install-root");
const startBtn = document.getElementById("kokoro-start");
const stopBtn = document.getElementById("kokoro-stop");
const autostopRow = document.getElementById("autostop-row");
const autostopToggle = document.getElementById("autostop-toggle");
const deviceSelect = document.getElementById("device-select");
const sourceDress = dressSelect(installSource);
const pipDress = dressSelect(pipSource);
const torchDress = dressSelect(torchSource);
const deviceDress = dressSelect(deviceSelect);
const downloadModel = document.getElementById("download-model");
const downloadCpu = document.getElementById("download-cpu");
const downloadGpu = document.getElementById("download-gpu");
const savePath = document.getElementById("save-path");
const errorSlots = {
  model: document.getElementById("error-model"),
  cpu: document.getElementById("error-cpu"),
  gpu: document.getElementById("error-gpu"),
  run: document.getElementById("error-run"),
  path: document.getElementById("error-path"),
};
const progressUi = {
  model: {
    wrap: document.getElementById("progress-model"),
    fill: document.getElementById("fill-model"),
    message: document.getElementById("message-model"),
  },
  cpu: {
    wrap: document.getElementById("progress-cpu"),
    fill: document.getElementById("fill-cpu"),
    message: document.getElementById("message-cpu"),
  },
  gpu: {
    wrap: document.getElementById("progress-gpu"),
    fill: document.getElementById("fill-gpu"),
    message: document.getElementById("message-gpu"),
  },
};

let pollTimer = null;
let activeComponent = "";
const ACTIVE_PHASES = new Set(["venv", "deps", "torch", "model", "verify"]);
const downloadButtons = { model: downloadModel, cpu: downloadCpu, gpu: downloadGpu };

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function showError(text, where = "run") {
  for (const [key, element] of Object.entries(errorSlots)) {
    const show = key === where && !!text;
    element.textContent = show ? text : "";
    element.hidden = !show;
  }
}

function hideProgress() {
  for (const ui of Object.values(progressUi)) ui.wrap.hidden = true;
}

function showProgress(component, percent, message) {
  const key = progressUi[component] ? component : activeComponent;
  if (!progressUi[key]) return;
  activeComponent = key;
  for (const [name, ui] of Object.entries(progressUi)) {
    const on = name === key;
    ui.wrap.hidden = !on;
    if (!on) continue;
    if (typeof percent === "number") ui.fill.style.width = `${percent}%`;
    ui.message.textContent = message || "";
  }
}

function ensurePolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollInstall, 1000);
}

async function pollInstall() {
  try {
    const response = await hana.api.fetch("kokoro-install");
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error(body.error || "读不到安装进度。");
    if (body.phase === "none") return;
    if (body.component) activeComponent = body.component;
    showProgress(activeComponent, body.percent, body.message || body.phase);
    if (body.phase === "done") {
      stopPolling();
      showProgress(activeComponent, 100, body.message || "已经具备。");
      setTimeout(() => location.reload(), 800);
    } else if (body.phase === "failed") {
      stopPolling();
      setBusy(false);
      showProgress(activeComponent, body.percent, body.message || "下载失败。");
      showError("");
    } else if (ACTIVE_PHASES.has(body.phase)) {
      setBusy(true);
      showError("");
    }
  } catch (error) {
    stopPolling();
    showError(error instanceof Error ? error.message : "读不到安装进度。", activeComponent || "run");
  }
}

function setBusy(busy) {
  for (const button of Object.values(downloadButtons)) button.disabled = busy;
  deviceSelect.disabled = busy;
  installSource.disabled = busy;
  pipSource.disabled = busy;
  torchSource.disabled = busy;
  sourceDress.sync();
  pipDress.sync();
  torchDress.sync();
  deviceDress.sync();
}

async function startInstall(component) {
  setBusy(true);
  showError("", component);
  try {
    const response = await hana.api.fetch("kokoro-install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        component,
        source: component === "cpu" ? pipSource.value : component === "gpu" ? torchSource.value : installSource.value,
        pipSource: pipSource.value,
        torchSource: torchSource.value,
        root: installRoot.value.trim(),
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || "下载没有启动。");
    activeComponent = component;
    showProgress(component, 0, "下载已启动…");
    ensurePolling();
  } catch (error) {
    stopPolling();
    hideProgress();
    setBusy(false);
    showError(error instanceof Error ? error.message : "下载没有启动。", component);
  }
}

downloadModel.addEventListener("click", () => startInstall("model"));
downloadCpu.addEventListener("click", () => startInstall("cpu"));
downloadGpu.addEventListener("click", () => startInstall("gpu"));

async function callService(path) {
  const response = await hana.api.fetch(path, { method: "POST" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.error || "操作没有成功。");
  return body;
}

deviceSelect.addEventListener("change", () => {
  if (pageLocked) return;
  startSwitch(deviceSelect.value === "cuda" ? "cuda" : "cpu");
});

let pageLocked = false;

function setPageLocked(locked) {
  pageLocked = locked;
  document.body.classList.toggle("page-locked", locked);
  for (const element of document.querySelectorAll("button, input, select")) {
    element.disabled = locked;
  }
  sourceDress.sync();
  pipDress.sync();
  torchDress.sync();
  deviceDress.sync();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDevice(target) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await wait(1000);
    let response;
    try {
      response = await hana.api.fetch("kokoro-live", { signal: AbortSignal.timeout(10000) });
    } catch {
      continue;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) continue;
    if (!body.running) continue;
    if (body.device === target) return;
    if (body.device) throw new Error(target === "cuda" ? "服务起来了，但没有用上显卡。" : "服务起来了，但不是 CPU。");
  }
  throw new Error("切换超时，服务没有在限定时间内起来。");
}

async function startSwitch(target) {
  setPageLocked(true);
  showError("", "run");
  setRow("kokoro-device", "loading", "正在切换…");
  try {
    const response = await hana.api.fetch("kokoro-device", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device: target }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || "切换失败。");
    if (body.pending) await waitForDevice(target);
    await loadKokoroStatus();
  } catch (error) {
    showError(error instanceof Error ? error.message : "切换失败。", "run");
    await loadKokoroStatus();
  } finally {
    setPageLocked(false);
  }
}

autostopToggle.addEventListener("change", async () => {
  const enabled = autostopToggle.checked;
  autostopToggle.disabled = true;
  try {
    const response = await hana.api.fetch("kokoro-autostop", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || "没有保存。");
    showError("", "run");
  } catch (error) {
    autostopToggle.checked = !enabled;
    showError(error instanceof Error ? error.message : "没有保存。", "run");
  } finally {
    autostopToggle.disabled = false;
  }
});

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  startBtn.textContent = "启动中…";
  try {
    await callService("kokoro-start");
    await loadKokoroStatus();
  } catch (error) {
    showError(error instanceof Error ? error.message : "启动失败。", "run");
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = "启动";
  }
});

stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  stopBtn.textContent = "停止中…";
  try {
    await callService("kokoro-stop");
    await loadKokoroStatus();
  } catch (error) {
    showError(error instanceof Error ? error.message : "停止失败。", "run");
  } finally {
    stopBtn.disabled = false;
    stopBtn.textContent = "停止";
  }
});

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
    showError("", "path");
    installRoot.value = body.root;
    await loadKokoroStatus();
  } catch (error) {
    showError(error instanceof Error ? error.message : "路径没有保存。", "path");
  } finally {
    savePath.disabled = false;
  }
});

// ---- 状态区 ----

function showPiece(id, ready, failed) {
  if (failed) {
    setRow(id, "bad", "读不到状态");
    return;
  }
  setRow(id, ready ? "ok" : "bad", ready ? "具备" : "未下载");
}

async function loadKokoroStatus() {
  setRow("kokoro-model", "loading", "正在查看…");
  setRow("kokoro-cpu", "loading", "正在查看…");
  setRow("kokoro-gpu", "loading", "正在查看…");
  setRow("kokoro-running", "loading", "正在查看…");
  setRow("kokoro-device", "loading", "正在查看…");
  document.getElementById("kokoro-path").textContent = "—";
  try {
    const response = await hana.api.fetch("kokoro-status");
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error(body.error || "读不到状态。");

    installRoot.value = body.path || body.defaultPath || "";
    document.getElementById("kokoro-path").textContent = body.path || "—";

    showPiece("kokoro-model", body.modelReady, body.probeFailed);
    showPiece("kokoro-cpu", body.cpuReady, body.probeFailed);
    showPiece("kokoro-gpu", body.gpuReady, body.probeFailed);
    if (body.probeFailed) {
      showError(body.probeError || "读不到状态。", "model");
      showError("", "cpu");
      showError("", "gpu");
    }

    installSource.hidden = !!body.modelReady;
    downloadModel.hidden = !!body.modelReady;
    pipSource.hidden = !!body.cpuReady;
    downloadCpu.hidden = !!body.cpuReady;
    torchSource.hidden = !!body.gpuReady;
    downloadGpu.hidden = !!body.gpuReady;

    const cpuOption = deviceSelect.querySelector('option[value="cpu"]');
    const gpuOption = deviceSelect.querySelector('option[value="cuda"]');
    cpuOption.disabled = !body.cpuReady;
    gpuOption.disabled = !body.gpuReady;
    deviceSelect.hidden = !(body.cpuReady || body.gpuReady);
    deviceSelect.value = body.targetDevice === "cuda" ? "cuda" : "cpu";

    if (body.running) {
      setRow("kokoro-running", "ok", body.foreign ? "服务运行中（另一个目录）" : "服务运行中");
      if (body.device) setRow("kokoro-device", "ok", body.device === "cuda" ? "GPU" : "CPU");
      else setRow("kokoro-device", "loading", "服务没有上报运行模式");
    } else {
      setRow("kokoro-running", "bad", "服务没有运行");
      setRow("kokoro-device", "loading", body.targetDevice === "cuda" ? "未运行，当前选择 GPU" : "未运行，当前选择 CPU");
    }

    const canRun = !!body.installed;
    startBtn.hidden = !canRun || body.running;
    stopBtn.hidden = !canRun || !body.running || body.foreign;
    autostopRow.hidden = !canRun;
    autostopToggle.checked = body.autoStop !== false;

    const stateResponse = await hana.api.fetch("kokoro-install");
    const state = await stateResponse.json().catch(() => ({}));
    if (state && ACTIVE_PHASES.has(state.phase)) {
      ensurePolling();
      await pollInstall();
    } else if (state && state.phase === "failed") {
      if (state.component) activeComponent = state.component;
      showProgress(activeComponent, state.percent, state.message || "下载失败。");
      showError("");
    } else {
      hideProgress();
    }
    sourceDress.sync();
    pipDress.sync();
    torchDress.sync();
    deviceDress.sync();
  } catch (error) {
    setRow("kokoro-model", "bad", "读不到状态");
    setRow("kokoro-cpu", "bad", "读不到状态");
    setRow("kokoro-gpu", "bad", "读不到状态");
    setRow("kokoro-running", "bad", "读不到状态");
    setRow("kokoro-device", "loading", error instanceof Error ? error.message : "读不到状态。");
  }
}

await hana.ready();
// 先把宿主主题设好，免得页面先闪一下兜底色。
followHostTheme();

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
