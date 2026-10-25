import { hana } from "./sdk.js";

const status = document.getElementById("status");
const engine = document.getElementById("engine");
const voice = document.getElementById("voice");
const rate = document.getElementById("rate");
const rateLabel = document.getElementById("rate-label");
const save = document.getElementById("save");
const probeStatus = document.getElementById("probe-status");
const probe = document.getElementById("probe");

let systemVoices = [];
let kokoroVoices = [];
let systemVoice = "";
let kokoroVoice = "zf_094";

function showRate() {
  rateLabel.textContent = Number(rate.value).toFixed(1);
}

function rememberVoice() {
  if (engine.value === "kokoro") kokoroVoice = voice.value || kokoroVoice;
  else systemVoice = voice.value;
}

function fillVoices() {
  voice.replaceChildren();
  if (engine.value === "kokoro") {
    const groups = new Map();
    for (const item of kokoroVoices) {
      let group = groups.get(item.group);
      if (!group) {
        group = document.createElement("optgroup");
        group.label = item.group;
        groups.set(item.group, group);
      }
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      group.append(option);
    }
    for (const group of groups.values()) voice.append(group);
    const selected = kokoroVoices.some((item) => item.id === kokoroVoice) ? kokoroVoice : "zf_094";
    voice.value = selected;
    return;
  }
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "自动（中文优先）";
  voice.append(auto);
  for (const item of systemVoices) {
    const option = document.createElement("option");
    option.value = item.name;
    option.textContent = item.culture ? `${item.name}（${item.culture}）` : item.name;
    voice.append(option);
  }
  voice.value = [...voice.options].some((option) => option.value === systemVoice) ? systemVoice : "";
}

async function savePrefs(doneText) {
  rememberVoice();
  save.disabled = true;
  status.textContent = "正在保存…";
  try {
    const response = await hana.api.fetch("preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voice: systemVoice,
        kokoroVoice,
        rate: Number(rate.value),
        engine: engine.value,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "保存失败。");
    status.textContent = doneText;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "保存失败。";
  } finally {
    save.disabled = false;
  }
}

rate.addEventListener("input", showRate);
rate.addEventListener("change", () => {
  showRate();
  const speed = Number(rate.value).toFixed(1);
  savePrefs(`语速已保存为 ${speed} 倍。再点「朗读」。`);
});
engine.addEventListener("change", fillVoices);
voice.addEventListener("change", rememberVoice);

save.addEventListener("click", () => {
  const speed = Number(rate.value).toFixed(1);
  const where = engine.value === "kokoro" ? "本地 Kokoro" : "Windows 系统语音";
  savePrefs(`已保存。下一次用${where}，语速 ${speed} 倍。`);
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
  if (!response.ok) throw new Error(body.error || "读不到声音列表。");
  systemVoices = Array.isArray(body.voices) ? body.voices : [];
  kokoroVoices = Array.isArray(body.kokoroVoices) ? body.kokoroVoices : [];
  systemVoice = typeof body.voice === "string" ? body.voice : "";
  kokoroVoice = typeof body.kokoroVoice === "string" && body.kokoroVoice ? body.kokoroVoice : "zf_094";
  engine.value = body.engine === "kokoro" ? "kokoro" : "system";
  rate.value = String(typeof body.rate === "number" ? body.rate : 1);
  showRate();
  fillVoices();
  status.textContent = `当前语速 ${Number(rate.value).toFixed(1)} 倍。换声音后要点保存，拖动语速松开就会保存。`;
} catch (error) {
  status.textContent = error instanceof Error ? error.message : "读不到声音列表。";
  save.disabled = true;
}
