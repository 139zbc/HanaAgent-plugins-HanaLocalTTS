// 兜底静态检查：找出每个 lib 文件里被"调用"的标识符（名字后跟 "("），
// 对照 本地声明 + import + 函数参数。只报可疑项，误报人工看。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["errors.js", "powershell.js", "kokoro.js", "speech.js", "speech-client.js", "routes.js"].map((f) => path.join(here, "lib", f));

const globals = new Set(["console", "JSON", "Math", "Number", "String", "Boolean", "Array", "Object", "Date", "Promise", "Set", "Map", "Buffer", "TextEncoder", "Error", "isNaN", "parseInt", "parseFloat", "Symbol", "process", "URL", "AbortController", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "encodeURIComponent", "decodeURIComponent", "fetch"]);

let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const local = new Set([...src.matchAll(/(?:function|const|let|var|class)\s+(\w+)/g)].map((m) => m[1]));
  const imported = new Set([...src.matchAll(/import\s*\{([^}]+)\}\s*from/g)].flatMap((m) => m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0])));
  const params = new Set();
  for (const m of src.matchAll(/function\s*(?:\w+)?\s*\(([^)]*)\)/g)) {
    for (const p of m[1].split(",")) {
      const name = p.trim().split(/[=\s]/)[0];
      if (/^[a-zA-Z_]\w*$/.test(name)) params.add(name);
    }
  }
  for (const m of src.matchAll(/\(([^()]*?)\)\s*=>/g)) {
    for (const p of m[1].split(",")) {
      const name = p.trim().split(/[=\s]/)[0];
      if (/^[a-zA-Z_]\w*$/.test(name)) params.add(name);
    }
  }
  const known = new Set([...local, ...imported, ...params, ...globals]);
  const clean = src
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // 保留模板字符串里的 ${...} 表达式，剥掉纯文本部分
    .replace(/`(?:\\.|[^`\\])*`/g, (seg) => seg.replace(/[^$]?\{[^{}]*\}/g, (x) => x.startsWith("${") ? " EXPR " : " "))
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, " ");
  for (const m of clean.matchAll(/(?<![\w$.])([A-Za-z_]\w*)\s*\(/g)) {
    const name = m[1];
    if (known.has(name)) continue;
    if (/^(if|for|while|switch|catch|function|return)$/.test(name)) continue;
    console.log(`${path.basename(f)}: 未定义调用 ${name}() (行 ${src.slice(0, m.index).split("\n").length})`);
    bad += 1;
    known.add(name);
  }
}
console.log(bad === 0 ? "no stray calls" : `${bad} stray call(s)`);
process.exit(bad === 0 ? 0 : 1);
