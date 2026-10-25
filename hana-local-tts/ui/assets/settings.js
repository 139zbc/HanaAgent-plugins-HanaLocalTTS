import { hana } from "./sdk.js";

const status = document.getElementById("status");
const voice = document.getElementById("voice");
const rate = document.getElementById("rate");
const rateLabel = document.getElementById("rate-label");
const save = document.getElementById("save");

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
      body: JSON.stringify({ voice: voice.value, rate: Number(rate.value) }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "保存失败。");
    status.textContent = "已保存。再点「朗读」，用的就是这个声音和语速。";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "保存失败。";
  } finally {
    save.disabled = false;
  }
});

await hana.ready();
try {
  const response = await hana.api.fetch("voices");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "读不到系统语音。");
  fillVoices(Array.isArray(body.voices) ? body.voices : [], typeof body.voice === "string" ? body.voice : "");
  rate.value = String(typeof body.rate === "number" ? body.rate : 1);
  showRate();
  status.textContent = "选好后点保存。下一次朗读才会换成新声音。";
} catch (error) {
  status.textContent = error instanceof Error ? error.message : "读不到系统语音。";
  save.disabled = true;
}
