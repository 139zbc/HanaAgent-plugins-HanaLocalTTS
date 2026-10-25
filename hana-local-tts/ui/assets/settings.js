import { hana } from "./sdk.js";

const status = document.getElementById("status");
const engine = document.getElementById("engine");
const voice = document.getElementById("voice");
const rate = document.getElementById("rate");
const rateLabel = document.getElementById("rate-label");
const save = document.getElementById("save");
const probeStatus = document.getElementById("probe-status");
const probe = document.getElementById("probe");

function showRate() {
  rateLabel.textContent = Number(rate.value).toFixed(1);
}

rate.addEventListener("input", showRate);

function fillVoices(voices, selected) {
  voice.replaceChildren();
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "自动（中文优先）";
  voice.append(auto);
  for (const item of voices) {
    const option = document.createElement("option");
    option.value = item.name;
    option.textContent = item.culture ? `${item.name}（${item.culture}）` : item.name;
    voice.append(option);
  }
  voice.value = [...voice.options].some((option) => option.value === selected) ? selected : "";
}

save.addEventListener("click", async () => {
  save.disabled = true;
  status.textContent = "正在保存…";
  try {
    const response = await hana.api.fetch("preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice: voice.value, rate: Number(rate.value), engine: engine.value }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "保存失败。");
    status.textContent = engine.value === "kokoro"
      ? "已保存。再点「朗读」。第一次用本地 Kokoro 要多等一会儿。"
      : "已保存。再点「朗读」，用的就是这个声音和语速。";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "保存失败。";
  } finally {
    save.disabled = false;
  }
});

probe.addEventListener("click", async () => {
  probe.disabled = true;
  probeStatus.textContent = "正在请宿主合成一句话…";
  try {
    const response = await hana.api.fetch("probe", { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || "合成没有走通。");
    probeStatus.textContent = "走通了。刚才那句「这是本地语音供应商测试」是宿主调用这个 App 读出来的。";
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
    ? "已注册。点「试一下合成」，听是不是这台电脑在读。"
    : (probeBody.error || "还没注册成语音供应商。");
  probe.disabled = !probeBody.ready;
} catch (error) {
  probeStatus.textContent = error instanceof Error ? error.message : "读不到供应商状态。";
  probe.disabled = true;
}

try {
  const response = await hana.api.fetch("voices");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "读不到系统语音。");
  engine.value = body.engine === "kokoro" ? "kokoro" : "system";
  fillVoices(Array.isArray(body.voices) ? body.voices : [], typeof body.voice === "string" ? body.voice : "");
  rate.value = String(typeof body.rate === "number" ? body.rate : 1);
  showRate();
  status.textContent = "选好后点保存。下一次朗读才会换成新声音。";
} catch (error) {
  status.textContent = error instanceof Error ? error.message : "读不到系统语音。";
  save.disabled = true;
}
