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

await hana.ready();
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
