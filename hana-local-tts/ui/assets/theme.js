// 把宿主当前主题应用到页面。
//
// 背景（踩过的坑）：
// 宿主把当前主题的变量打包成一份 CSS，挂在 /api/apps/theme.css?theme=<主题名>，
// 这个端点是公开的，页面直接 fetch 就能拿到。
// 但 SDK 只在收到 THEME_CHANGED 事件时才去拉那份 CSS，
// 首次加载并不主动拉——所以页面里根本没有那份样式表，
// 颜色只能靠我们 CSS 里的兜底值，看着就和别的页面不是一个主题。
//
// 这里在首次加载时主动拉一次并注入 <style>，主题切换时再拉一次。
// 注意：这份 CSS 的变量挂在 :root 上，不需要设 data-theme。

import { hana } from './sdk.js';

const THEME_STYLE_ATTR = 'data-hana-theme-style';

// 宿主用 html[data-platform] 区分平台：Windows 上不覆盖滚动条样式，
// 用系统原生那条（9px）；其它平台才画 4px 的 webkit 滑块。
// 我们是 App 页面，拿不到宿主的这个标记，自己按系统判断设上。
function markPlatform() {
  const platform = /win/i.test(navigator.userAgent) ? 'win32' : 'web';
  document.documentElement.setAttribute('data-platform', platform);
}

// 把宿主主题样式表取回来注入页面。
async function injectThemeStylesheet(cssUrl) {
  if (!cssUrl) return;
  const response = await fetch(cssUrl, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`主题样式表请求失败：${response.status}`);
  }
  const css = await response.text();
  const head = document.head || document.documentElement;
  if (!head) return;
  let element = document.querySelector(`style[${THEME_STYLE_ATTR}]`);
  if (!element) {
    element = document.createElement('style');
    element.setAttribute(THEME_STYLE_ATTR, '');
  }
  element.textContent = css;
  head.appendChild(element);
}

async function applyTheme(snapshot) {
  try {
    await injectThemeStylesheet(snapshot && snapshot.cssUrl);
  } catch (error) {
    console.error('[hana-local-tts] 应用宿主主题失败', error);
  }
}

// 首次加载 + 主题切换时都应用一次。
export function followHostTheme() {
  markPlatform();
  applyTheme(hana.theme.getSnapshot());
  hana.theme.subscribe((snapshot) => {
    applyTheme(snapshot);
  });
}
