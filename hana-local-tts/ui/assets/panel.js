import { hana } from './sdk.js';

const $ = (id) => document.getElementById(id);

const ui = {
  sub: $('panel-sub'),
  engine: $('v-engine'),
  voice: $('v-voice'),
  rate: $('v-rate'),
  kokoro: $('v-kokoro'),
  device: $('v-device'),
  hint: $('panel-hint'),
  body: $('panel-body'),
  error: $('panel-error'),
  errorText: $('panel-error-text'),
  retry: $('panel-retry'),
};

function setValue(element, text, state) {
  element.textContent = text;
  if (state) element.dataset.state = state;
  else delete element.dataset.state;
}

function showError(text) {
  ui.body.hidden = true;
  ui.error.hidden = false;
  ui.errorText.textContent = text;
}

function showBody() {
  ui.body.hidden = false;
  ui.error.hidden = true;
}

function setLoading() {
  showBody();
  ui.hint.hidden = true;
  for (const element of [ui.engine, ui.voice, ui.rate, ui.kokoro, ui.device]) {
    setValue(element, '正在读取…', 'loading');
  }
}

async function getJson(path) {
  const response = await hana.api.fetch(path);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error(body.error || '读不到状态。');
  return body;
}

function systemVoiceName(prefs, voices) {
  const name = typeof prefs.voice === 'string' ? prefs.voice : '';
  if (!name) return '系统默认声音';
  const found = voices.find((item) => item.name === name);
  return found ? found.name : name;
}

function kokoroVoiceName(prefs, kokoroVoices) {
  const id = typeof prefs.kokoroVoice === 'string' ? prefs.kokoroVoice : '';
  const found = kokoroVoices.find((item) => item.id === id);
  return found ? found.label : id || '未选择';
}

function rateText(rate) {
  const number = Number(rate);
  if (!Number.isFinite(number)) return '1 倍';
  return `${Math.round(number * 10) / 10} 倍`;
}

function renderPrefs(prefs) {
  const kokoro = prefs.engine === 'kokoro';
  setValue(ui.engine, kokoro ? '本地 Kokoro' : 'Windows 系统语音');
  setValue(ui.voice, kokoro
    ? kokoroVoiceName(prefs, prefs.kokoroVoices || [])
    : systemVoiceName(prefs, prefs.voices || []));
  setValue(ui.rate, rateText(prefs.rate));

  const bits = [
    kokoro ? '本地 Kokoro' : '系统声音',
    kokoro ? kokoroVoiceName(prefs, prefs.kokoroVoices || []) : systemVoiceName(prefs, prefs.voices || []),
    rateText(prefs.rate),
  ];
  ui.sub.textContent = bits.join(' · ');
}

function renderKokoro(status) {
  if (!status.installed) {
    setValue(ui.kokoro, '没有安装', 'muted');
    setValue(ui.device, '—', 'muted');
    return;
  }
  if (status.running) {
    setValue(ui.kokoro, status.foreign ? '服务运行中（另一个目录）' : '服务运行中', status.foreign ? 'muted' : 'ok');
    setValue(ui.device, status.device === 'cuda' ? 'GPU（显卡）' : 'CPU', 'ok');
    return;
  }
  setValue(ui.kokoro, '服务没有运行', 'muted');
  setValue(ui.device, '服务没运行时看不出', 'muted');
}

function renderHint(prefs, status) {
  const lines = [];
  if (prefs && prefs.engine === 'kokoro') {
    lines.push('声音和语速在「多媒体 → 语音合成 → 本地语音朗读」里改。');
  } else if (prefs) {
    lines.push('现在用的是 Windows 系统声音。要换成本地 Kokoro，去「多媒体 → 语音合成」里改朗读来源。');
  }
  if (status && !status.installed) {
    lines.push('本地 Kokoro 还没装。装好后中文音色更自然，还能用显卡加速，安装入口在这个 App 的设置里。');
  }
  ui.hint.textContent = lines.join(' ');
  ui.hint.hidden = lines.length === 0;
}

async function load() {
  setLoading();
  const [prefsResult, statusResult] = await Promise.allSettled([
    getJson('voices'),
    getJson('kokoro-status'),
  ]);

  const prefs = prefsResult.status === 'fulfilled' ? prefsResult.value : null;
  const status = statusResult.status === 'fulfilled' ? statusResult.value : null;

  if (!prefs && !status) {
    showError('读不到 App 的状态。点「重新读取」再试一次；一直读不到的话，去设置里看看这个 App 是否已加载。');
    ui.sub.textContent = '状态没读出来。';
    return;
  }

  showBody();
  if (prefs) {
    renderPrefs(prefs);
  } else {
    setValue(ui.engine, '读不到', 'bad');
    setValue(ui.voice, '读不到', 'bad');
    setValue(ui.rate, '读不到', 'bad');
    ui.sub.textContent = '状态读了一半。';
  }
  if (status) {
    renderKokoro(status);
  } else {
    setValue(ui.kokoro, '读不到', 'bad');
    setValue(ui.device, '读不到', 'bad');
  }
  renderHint(prefs, status);
}

ui.retry.addEventListener('click', () => {
  load();
});

// 面板常开着，重新拿到焦点时刷新一次状态；不做轮询，避免一直跑 PowerShell。
window.addEventListener('focus', () => {
  load();
});

await hana.ready();
load();
