// 比对：拆分后每个函数体与原 index.js 一字不差（忽略 export/async 前缀与空白量）。
import fs from "node:fs";
import { execSync } from "node:child_process";

const orig = fs.readFileSync(process.env.TEMP + "/orig-index.js", "utf8");
const now = ["index.js", "lib/errors.js", "lib/powershell.js", "lib/kokoro.js", "lib/speech.js", "lib/speech-client.js", "lib/routes.js"]
  .map((f) => fs.readFileSync("hana-local-tts/" + f, "utf8"))
  .join("\n");

const stripHead = (s) => s.replace(/^(?:export )?(?:async )?function /, "function ");
const norm = (s) => stripHead(s).replace(/\s+/g, " ").trim();

let diff = 0;
let checked = 0;
for (const m of orig.matchAll(/^(?:export )?(?:async )?function (\w+)[\s\S]*?\n\}/gm)) {
  const name = m[1];
  const re = new RegExp("(?:export )?(?:async )?function " + name + "\\b[\\s\\S]*?\\n\\}");
  const nm = now.match(re);
  checked += 1;
  if (!nm) { console.log("找不到:", name); diff += 1; continue; }
  if (norm(m[0]) !== norm(nm[0])) { console.log("不同:", name); diff += 1; }
}
console.log(`函数比对: ${checked} 个, ${diff} 个有差异`);

// 常量比对：单行 const（值不含换行的）
let cdiff = 0;
let cchecked = 0;
for (const m of orig.matchAll(/^const (\w+) = .*;/gm)) {
  const name = m[1];
  const re = new RegExp("(?:export )?const " + name + " = .*;");
  const nm = now.match(re);
  cchecked += 1;
  if (!nm) { console.log("常量找不到:", name); cdiff += 1; continue; }
  if (norm(m[0]) !== norm(nm[0].replace(/^export /, ""))) { console.log("常量不同:", name); cdiff += 1; }
}
console.log(`常量比对: ${cchecked} 个, ${cdiff} 个问题`);
process.exit(diff === 0 && cdiff === 0 ? 0 : 1);
