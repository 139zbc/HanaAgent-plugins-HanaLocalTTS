// 静态自查：每个 lib 文件的 import 名必须真实存在于目标模块的 export 里。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["errors.js", "powershell.js", "kokoro.js", "speech.js", "speech-client.js", "routes.js"].map((f) => path.join("lib", f));

const exportTable = {};
for (const f of files) {
  const src = fs.readFileSync(path.join(here, f), "utf8");
  exportTable[f] = new Set(
    [...src.matchAll(/export (?:async )?(?:function|const|let|class) (\w+)/g)].map((m) => m[1]),
  );
}

let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(here, f), "utf8");
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    const mod = m[2];
    const target = path.basename(mod); // 只查相对导入的 lib 内模块
    if (!mod.startsWith(".") || !exportTable[target]) continue;
    for (const name of names) {
      if (!exportTable[target].has(name)) {
        console.log(`${f}: import { ${name} } from "${mod}" — 目标没有这个导出`);
        bad += 1;
      }
    }
  }
}
console.log(bad === 0 ? "imports all ok" : `${bad} bad import(s)`);
process.exit(bad === 0 ? 0 : 1);
