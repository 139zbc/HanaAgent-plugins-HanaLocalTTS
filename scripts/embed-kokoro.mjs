// 把 kokoro/server.py、kokoro/install.py 和 kokoro/helper.py 内嵌成 base64 模块。
// 改那几个 Python 文件后重新运行：node scripts/embed-kokoro.mjs
import { readFileSync, writeFileSync } from "node:fs";

const b64 = (p) => Buffer.from(readFileSync(p)).toString("base64");
const out = [
  "// 由 kokoro/server.py 和 kokoro/install.py 生成；改那两个文件后重新生成。",
  "// 生成命令：node scripts/embed-kokoro.mjs",
  `export const SERVER_PY_B64 = '${b64("kokoro/server.py")}';`,
  `export const INSTALL_PY_B64 = '${b64("kokoro/install.py")}';`,
  `export const HELPER_PY_B64 = '${b64("kokoro/helper.py")}';`,
  "",
].join("\n");
writeFileSync("hana-local-tts/kokoro-files.js", out, "utf8");
console.log("written hana-local-tts/kokoro-files.js", out.length, "bytes");
