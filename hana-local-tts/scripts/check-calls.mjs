// 兜底静态检查：找出每个文件里"用了但没定义/没导入"的标识符。
//
// 查两种形态：
//   1. name()      —— 直接调用
//   2. name.prop   —— 成员访问（基准名 name 必须有出处）
//
// 为什么要有第 2 种：只查 name() 的话，成员访问这一类漏引查不出来。
// 实测踩过：lib/routes.js 里用了 speech.js 的模块私有变量 readyVoices
//（.clear() 形态），两个自查脚本都没报，路由一跑到那行就抛 ReferenceError，
// 改数据目录整个失败。
//
// 只报可疑项，误报人工看。找不到出处的一律列出来。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "index.js",
  "kokoro-runtime.js",
  "kokoro-voices.js",
  "lib/errors.js",
  "lib/powershell.js",
  "lib/kokoro.js",
  "lib/speech.js",
  "lib/speech-client.js",
  "lib/routes.js",
].map((f) => path.join(here, f));

// 宿主/Node 自带的名字：不查出处。
const globals = new Set([
  "console", "JSON", "Math", "Number", "String", "Boolean", "Array", "Object", "Date", "Promise",
  "Set", "Map", "WeakMap", "WeakSet", "Buffer", "TextEncoder", "TextDecoder", "Error", "TypeError",
  "RangeError", "SyntaxError", "isNaN", "isFinite", "parseInt", "parseFloat", "Symbol", "BigInt",
  "process", "URL", "URLSearchParams", "AbortController", "AbortSignal", "Response", "Request",
  "Headers", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "setImmediate",
  "clearImmediate", "queueMicrotask", "encodeURIComponent", "decodeURIComponent", "encodeURI",
  "decodeURI", "fetch", "structuredClone", "Intl", "Reflect", "Proxy", "RegExp", "globalThis",
  "crypto", "performance", "WeakRef", "FinalizationRegistry",
]);

// 关键字：不是变量，出现形态像调用也不查。
const keywords = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "async", "await", "typeof",
  "new", "delete", "void", "do", "else", "try", "finally", "throw", "case", "super", "constructor",
  "get", "set", "of", "in", "instanceof", "class", "import", "export", "default", "with",
]);

// 正则字面量前面的关键字：这些位置上的 "/" 是正则，不是除号。
const regexAllowedBefore = new Set([
  "return", "typeof", "case", "in", "of", "do", "else", "yield", "await", "new", "delete", "void",
]);

// 把注释、字符串、正则字面量的内容换成等长的空格，位置不变。
// 这样正则跑在"代码骨架"上，不会把 PowerShell 脚本、路径、正则里的词当成标识符。
function maskLiterals(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  const blank = (ch) => (ch === "\n" ? "\n" : " ");
  // 上一个有效字符，用来判断 "/" 是除号还是正则开头。
  const lastSignificant = () => {
    for (let k = out.length - 1; k >= 0; k -= 1) {
      const ch = out[k];
      if (ch === " " || ch === "\t") continue;
      return ch;
    }
    return "";
  };
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  "; i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out += blank(src[i]); i += 1; }
      if (i < n) { out += "  "; i += 2; }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += " "; i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") { out += "  "; i += 2; continue; }
        out += blank(src[i]); i += 1;
      }
      if (i < n) { out += " "; i += 1; }
      continue;
    }
    if (ch === "`") {
      out += " "; i += 1;
      while (i < n && src[i] !== "`") {
        if (src[i] === "\\") { out += "  "; i += 2; continue; }
        // 模板里的 ${...} 是真代码，原样留着。
        if (src[i] === "$" && src[i + 1] === "{") {
          let depth = 0;
          let j = i + 1;
          for (; j < n; j += 1) {
            if (src[j] === "{") depth += 1;
            else if (src[j] === "}") { depth -= 1; if (depth === 0) break; }
          }
          out += src.slice(i, Math.min(j + 1, n));
          i = j + 1;
          continue;
        }
        out += blank(src[i]); i += 1;
      }
      if (i < n) { out += " "; i += 1; }
      continue;
    }
    if (ch === "/") {
      // 上一段有效代码决定这是不是正则字面量的开头。
      const prev = lastSignificant();
      const prevWord = (() => {
        const m = out.match(/([A-Za-z_]\w*)\s*$/);
        return m ? m[1] : "";
      })();
      const isRegex = prev === "" || "(,=:[!&|?{};+-*%~^".includes(prev) || regexAllowedBefore.has(prevWord);
      if (isRegex) {
        out += " "; i += 1;
        let inClass = false;
        while (i < n) {
          const cur = src[i];
          if (cur === "\\") { out += "  "; i += 2; continue; }
          if (cur === "[") inClass = true;
          else if (cur === "]") inClass = false;
          else if (cur === "/" && !inClass) break;
          else if (cur === "\n") break;
          out += blank(cur); i += 1;
        }
        if (i < n && src[i] === "/") { out += " "; i += 1; }
        // 正则后面的标志位（/x/i）也要抹掉，不然 "i.test(...)" 会被当成成员访问。
        while (i < n && /[a-z]/.test(src[i])) { out += " "; i += 1; }
        continue;
      }
    }
    out += ch; i += 1;
  }
  return out;
}

// 从一段参数/解构列表里取出变量名：{ a, b: c = 1 } -> a, c
function namesFrom(pattern) {
  const found = [];
  for (const piece of pattern.split(",")) {
    const text = piece.trim();
    if (!text) continue;
    const braces = text.match(/[{[]([^\]}]*)[}\]]/);
    if (braces) {
      for (const inner of braces[1].split(",")) {
        const name = inner.trim().split(":").pop().split("=")[0].trim();
        if (/^[A-Za-z_]\w*$/.test(name)) found.push(name);
      }
      continue;
    }
    const name = text.split(":").pop().split("=")[0].trim();
    if (/^[A-Za-z_]\w*$/.test(name)) found.push(name);
  }
  return found;
}

function collectNames(src, masked) {
  const names = new Set();
  // import：默认导入、命名导入（带 as）、命名空间导入。
  for (const m of src.matchAll(/import\s+([^;]+?)\s+from\s+["'][^"']*["']/g)) {
    const clause = m[1];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const item of braces[1].split(",")) {
        const name = item.trim().split(/\s+as\s+/).pop().trim();
        if (/^[A-Za-z_]\w*$/.test(name)) names.add(name);
      }
    }
    const rest = clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
    for (const item of rest.split(/\s+/)) {
      if (item && item !== "*" && item !== "as") names.add(item);
    }
  }
  // 声明：function / const / let / var / class，以及解构声明。
  for (const m of masked.matchAll(/(?<![\w$.])(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/g)) names.add(m[1]);
  for (const m of masked.matchAll(/(?<![\w$.])(?:export\s+)?(?:const|let|var)\s+(\w+)/g)) names.add(m[1]);
  for (const m of masked.matchAll(/(?<![\w$.])(?:export\s+)?class\s+(\w+)/g)) names.add(m[1]);
  for (const m of masked.matchAll(/(?<![\w$.])(?:const|let|var)\s*\{([^}]*)\}/g)) for (const name of namesFrom(m[1])) names.add(name);
  for (const m of masked.matchAll(/(?<![\w$.])(?:const|let|var)\s*\[([^\]]*)\]/g)) for (const name of namesFrom(m[1])) names.add(name);
  // 参数：函数形参、箭头形参、catch 形参。
  for (const m of masked.matchAll(/(?<![\w$.])function\s*\*?\s*\w*\s*\(([^)]*)\)/g)) for (const name of namesFrom(m[1])) names.add(name);
  for (const m of masked.matchAll(/\(([^()]*)\)\s*=>/g)) for (const name of namesFrom(m[1])) names.add(name);
  for (const m of masked.matchAll(/(?<![\w$.])(\w+)\s*=>/g)) names.add(m[1]);
  for (const m of masked.matchAll(/catch\s*\(\s*([\w{[]+)/g)) for (const name of namesFrom(m[1])) names.add(name);
  // 对象/类里的方法简写：name(args) { ... } —— 方法名本身和形参都算本地定义。
  for (const m of masked.matchAll(/(?<![\w$.])([A-Za-z_]\w*)\s*\(([^()]*)\)\s*\{/g)) {
    const name = m[1];
    if (keywords.has(name)) continue;
    names.add(name);
    for (const p of namesFrom(m[2])) names.add(p);
  }
  return names;
}

let bad = 0;
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const masked = maskLiterals(src);
  const known = new Set([...collectNames(src, masked), ...globals]);
  const lineAt = (index) => src.slice(0, index).split("\n").length;
  const report = (text) => {
    console.log(`${path.basename(file)}: ${text}`);
    bad += 1;
  };

  // 1) 直接调用：name( —— 方法简写 name() { } 不算调用。
  for (const m of masked.matchAll(/(?<![\w$.])([A-Za-z_]\w*)\s*\(/g)) {
    const name = m[1];
    if (known.has(name) || keywords.has(name)) continue;
    const after = masked.slice(m.index + m[0].length);
    if (/^\s*\)\s*\{/.test(after)) continue; // 方法定义
    report(`未定义调用 ${name}() (行 ${lineAt(m.index)})`);
    known.add(name);
  }
  // 2) 成员访问：name.prop —— 基准名必须有着落。
  for (const m of masked.matchAll(/(?<![\w$.])([A-Za-z_]\w*)\s*\??\.\s*([A-Za-z_]\w*)/g)) {
    const base = m[1];
    if (known.has(base) || keywords.has(base)) continue;
    report(`未定义成员 ${base}.${m[2]} (行 ${lineAt(m.index)})`);
    known.add(base);
  }
}
console.log(bad === 0 ? "no stray names" : `${bad} stray name(s)`);
process.exit(bad === 0 ? 0 : 1);
