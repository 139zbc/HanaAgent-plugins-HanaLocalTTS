// 查未使用的 import（每个名字在文件里只出现一次 = 只有 import 行本身）。
import fs from "node:fs";

let unused = 0;
for (const f of ["errors", "powershell", "kokoro", "speech", "speech-client", "routes"]) {
  const src = fs.readFileSync(`hana-local-tts/lib/${f}.js`, "utf8");
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    for (let name of m[1].split(",")) {
      name = name.trim().split(/\s+as\s+/)[0];
      if (!name) continue;
      const re = new RegExp("\\b" + name + "\\b", "g");
      const uses = (src.match(re) || []).length;
      if (uses <= 1) {
        console.log(`${f}.js: 可能没用到 ${name} (from ${m[2]})`);
        unused += 1;
      }
    }
  }
}
console.log(unused === 0 ? "no unused imports" : `${unused} unused import(s)`);
