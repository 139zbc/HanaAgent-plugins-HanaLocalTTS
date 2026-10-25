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

async function loadKokoroStatus() {
  setRow("kokoro-installed", "loading", "正在查看…");
  setRow("kokoro-running", "loading", "正在查看…");
  setRow("kokoro-device", "loading", "正在查看…");
  document.getElementById("kokoro-path").textContent = "—";
  try {
    const response = await hana.api.fetch("kokoro-status");
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error(body.error || "读不到状态。");

    setRow("kokoro-installed", body.installed ? "ok" : "bad",
      body.installed ? (typeof body.dirGB === "number" ? `已安装（约 ${body.dirGB} GB）` : "已安装") : "没有安装");
    document.getElementById("kokoro-path").textContent = body.path || "—";

    if (body.running) {
      setRow("kokoro-running", "ok", "服务运行中");
      if (body.device) {
        setRow("kokoro-device", "ok", body.device === "cuda" ? "GPU（显卡）" : "CPU");
      } else {
        setRow("kokoro-device", "loading", "服务没有上报运行模式");
      }
    } else {
      setRow("kokoro-running", "bad", "服务没有运行");
      setRow("kokoro-device", "loading", "服务没有运行时看不出");
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
