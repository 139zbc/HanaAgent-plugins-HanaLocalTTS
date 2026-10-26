import { hana } from './sdk.js';
import { followHostTheme } from './theme.js';

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
  message: $('panel-message'),
  serviceFoot: $('service-foot'),
  serviceBtn: $('btn-service'),
  speakBtn: $('btn-speak'),
};

// 当前 Kokoro 状态。启停按钮按它显示，null 表示还没读到。
let status = null;
// 上一次读取还在跑时不再重复读：每次读取都要起 PowerShell，叠加会拖慢机器。
let loading = false;

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

// 操作结果提示。state 取 ok / bad / busy。
function setMessage(text, state) {
  if (!text) {
    ui.message.hidden = true;
    ui.message.textContent = '';
    delete ui.message.dataset.state;
    return;
  }
  ui.message.hidden = false;
  ui.message.textContent = text;
  ui.message.dataset.state = state || 'busy';
}

async function getJson(path) {
  const response = await hana.api.fetch(path);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error(body.error || '读不到状态。');
  return body;
}

async function postJson(path) {
  const response = await hana.api.fetch(path, { method: 'POST' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error || body.ok === false) {
    throw new Error(body.error || '操作没有成功。');
  }
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

function renderKokoro(state) {
  if (!state.installed) {
    setValue(ui.kokoro, '没有安装', 'muted');
    setValue(ui.device, '—', 'muted');
    return;
  }
  if (state.running) {
    setValue(ui.kokoro, state.foreign ? '服务运行中（另一个目录）' : '服务运行中', state.foreign ? 'muted' : 'ok');
    setValue(ui.device, state.device === 'cuda' ? 'GPU' : 'CPU', 'ok');
    return;
  }
  setValue(ui.kokoro, '服务没有运行', 'muted');
  setValue(ui.device, '服务没运行时看不出', 'muted');
}

// 启停按钮：装了 Kokoro 才有。运行中显示停止，没运行显示启动；外来目录的服务停不了。
function renderServiceButton(state) {
  if (!state || !state.installed) {
    ui.serviceFoot.hidden = true;
    return;
  }
  ui.serviceFoot.hidden = false;
  const running = state.running && !state.foreign;
  ui.serviceBtn.textContent = running ? '停止服务' : '启动服务';
  ui.serviceBtn.dataset.action = running ? 'stop' : 'start';
}

function renderHint(prefs, state) {
  const lines = [];
  if (prefs && prefs.engine === 'kokoro') {
    lines.push('声音和语速在「多媒体 → 语音合成 → 本地语音朗读」里改。');
  } else if (prefs) {
    lines.push('现在用的是 Windows 系统声音。要换成本地 Kokoro，去「多媒体 → 语音合成」里改朗读来源。');
  }
  // 读不到宿主那份时，显示的是 App 自己存的旧值，得说清楚。
  if (prefs && prefs.prefsSource === 'app') {
    lines.push('暂时读不到多媒体里的设置，这里显示的是本 App 存的旧值。');
  }
  if (state && !state.installed) {
    lines.push('本地 Kokoro 还没装。装好后中文音色更自然，还能用显卡加速，安装入口在这个 App 的设置里。');
  }
  ui.hint.textContent = lines.join(' ');
  ui.hint.hidden = lines.length === 0;
}

// silent：不把面板清回“正在读取”；force：即使有读取在跑也再读一次。
async function load({ silent = false, force = false } = {}) {
  if (loading && !force) return;
  loading = true;
  if (!silent) setLoading();
  try {
    await refresh();
  } finally {
    loading = false;
  }
}

async function refresh() {
  const [prefsResult, statusResult] = await Promise.allSettled([
    getJson('voices'),
    getJson('kokoro-status'),
  ]);

  const prefs = prefsResult.status === 'fulfilled' ? prefsResult.value : null;
  const state = statusResult.status === 'fulfilled' ? statusResult.value : null;
  status = state;

  if (!prefs && !state) {
    showError('读不到 App 的状态。点「重新读取」再试一次；一直读不到的话，去设置里看看这个 App 是否已加载。');
    ui.sub.textContent = '状态没读出来。';
    renderServiceButton(null);
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
  if (state) {
    renderKokoro(state);
  } else {
    setValue(ui.kokoro, '读不到', 'bad');
    setValue(ui.device, '读不到', 'bad');
  }
  renderServiceButton(state);
  renderHint(prefs, state);
}

ui.retry.addEventListener('click', () => {
  load();
});

// 试读一句：走宿主语音合成供应商，和设置页的「试一下合成」同一条路。
ui.speakBtn.addEventListener('click', async () => {
  ui.speakBtn.disabled = true;
  ui.speakBtn.textContent = '试读中…';
  setMessage('正在合成并朗读，第一次可能要等一会儿…', 'busy');
  try {
    await postJson('probe');
    setMessage('功能正常', 'ok');
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '试读失败。', 'bad');
  } finally {
    ui.speakBtn.disabled = false;
    ui.speakBtn.textContent = '试读一句';
  }
});

// 启停 Kokoro 服务。
ui.serviceBtn.addEventListener('click', async () => {
  const action = ui.serviceBtn.dataset.action === 'stop' ? 'stop' : 'start';
  const label = action === 'stop' ? '停止服务' : '启动服务';
  ui.serviceBtn.disabled = true;
  ui.serviceBtn.textContent = action === 'stop' ? '停止中…' : '启动中…';
  setMessage(action === 'stop' ? '正在停止服务…' : '正在启动服务…', 'busy');
  try {
    await postJson(action === 'stop' ? 'kokoro-stop' : 'kokoro-start');
    await load({ silent: true, force: true });
    const running = status && status.running && !status.foreign;
    setMessage(running ? '服务在跑。' : '服务已停。', 'ok');
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '操作没有成功。', 'bad');
    await load({ silent: true, force: true });
  } finally {
    ui.serviceBtn.disabled = false;
    renderServiceButton(status);
  }
});

// 面板常开着，重新拿到焦点时刷新一次状态；不做轮询，避免一直跑 PowerShell。
window.addEventListener('focus', () => {
  load();
});

await hana.ready();
// 先把宿主主题设好，再读状态，免得页面先闪一下兜底色。
followHostTheme();
load();
