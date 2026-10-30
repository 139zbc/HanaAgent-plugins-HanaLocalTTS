// 静态自查：设置页 JS 里用到的元素 id 必须真的在 settings.html 里。
//
// 为什么要有这个：写错 id 时 getElementById 拿到 null，接着 element.dataset 就抛
// "Cannot read properties of null (reading 'dataset')"，整个状态刷新直接挂掉，
// 页面上一片「读不到状态」（实测：取消下载后就是这个症状）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = path.join(here, "ui", "settings.html");
const jsPath = path.join(here, "ui", "assets", "settings.js");

const html = fs.readFileSync(htmlPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// JS 里出现的元素 id：字面量形式的 getElementById / setRow，以及行 id 映射函数返回的值。
const used = new Set();
for (const m of js.matchAll(/getElementById\("([^"]+)"\)/g)) used.add(m[1]);
for (const m of js.matchAll(/setRow\(\s*"([^"]+)"/g)) used.add(m[1]);
for (const m of js.matchAll(/id:\s*"([^"]+)"/g)) used.add(m[1]);
const mapper = js.match(/function rowIdForComponent\([^)]*\)\s*\{([\s\S]*?)\n\}/);
if (mapper) for (const m of mapper[1].matchAll(/return\s+"([^"]+)"/g)) used.add(m[1]);

let bad = 0;

// 这几个是下载项的名字（model / cpu / gpu），不是行 id。
// 直接当行 id 用会 getElementById 到 null，然后整页报「读不到状态」。
for (const m of js.matchAll(/setRow\(\s*(component|activeComponent|state\.component)\b/g)) {
  console.log(`settings.js: setRow(${m[1]}, ...) — 下载项的名字不是行 id，要过 rowIdForComponent`);
  bad += 1;
}

for (const id of [...used].sort()) {
  if (htmlIds.has(id)) continue;
  console.log(`settings.js 用了不存在的元素 id：${id}`);
  bad += 1;
}

// 反过来：HTML 里那些明显是给 JS 用的 id，JS 里一次都没提到，多半是改名字时漏了。
const prefixes = ["kokoro-", "error-", "progress-", "fill-", "message-"];
for (const id of [...htmlIds].sort()) {
  if (!prefixes.some((prefix) => id.startsWith(prefix))) continue;
  if (used.has(id) || js.includes(`"${id}"`)) continue;
  console.log(`settings.html 里的 ${id} 在 settings.js 里没被用到`);
  bad += 1;
}

console.log(bad === 0 ? "ui ids ok" : `${bad} ui id problem(s)`);
process.exit(bad === 0 ? 0 : 1);
