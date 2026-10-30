// 打发布包：确定性 zip + 市场条目 json + 市场索引 json。
//
// 产物约定与 Hana 官方 `scripts/extension-pack.mjs` / `scripts/extension-index-build.mjs` 对齐：
//   dist/app-<id>-<version>.zip          安装包，manifest.json 在压缩包根目录
//   dist/app-<id>-<version>.entry.json    单条 MarketItemV2，archive.url 留 {{BASE_URL}} 占位
//   dist/index.v2.json                    MarketIndexV2，条目已定址
//
// 用法：node scripts/package-release.mjs [--base-url <https 前缀>] [--publisher <名字>]
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const pkgDir = path.join(root, "hana-local-tts");
const outDir = path.join(root, "dist");

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

// 默认的下载地址跟着 manifest 的版本走，改版本号时不用再改这里。
const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "manifest.json"), "utf8"));
const version = manifest.version;

const BASE_URL = argValue("--base-url", `https://github.com/OWNER/REPO/releases/download/v${version}`);
const PUBLISHER = argValue("--publisher", "hana-local-tts contributors");
const REPO_URL = argValue("--repo-url", "https://github.com/OWNER/REPO");

// ---------------------------------------------------------------- 确定性 zip

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS 时间 0、日期 0x0021（1980-01-01）：两次打包字节完全一致。
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function zipEntries(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(entry.data.length & 0 ? 0 : 0o644 << 16, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const central = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, central, end]);
}

// ---------------------------------------------------------------- 收集包内文件

function collectFiles(dir, prefix = "") {
  const out = [];
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) out.push(...collectFiles(full, rel));
    else if (dirent.isFile()) out.push({ name: rel, full });
  }
  return out;
}

function buildEntries() {
  const files = collectFiles(pkgDir).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return files.map((file) => {
    // 包里的 README 用仓库的对外文档，脚手架那份英文说明不给用户看。
    if (file.name === "README.md") return { name: file.name, data: fs.readFileSync(path.join(root, "README.md")) };
    return { name: file.name, data: fs.readFileSync(file.full) };
  });
}

// ---------------------------------------------------------------- 官方校验器

// 官方 SDK 的 extension-market-index.js 是 ESM，但插件包里没有 package.json，
// 直接 import 会被当成 CJS。复制到临时目录补一个 type=module 再导入。
async function loadMarketValidator() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hana-market-"));
  const sdkDir = path.join(pkgDir, "sdk");
  for (const name of ["extension-market-index.js", "extension-contract.js"]) {
    fs.copyFileSync(path.join(sdkDir, name), path.join(temp, name));
  }
  fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ type: "module" }));
  const mod = await import(pathToFileURL(path.join(temp, "extension-market-index.js")).href);
  return mod.validateMarketIndexV2;
}

// ---------------------------------------------------------------- 主流程

const zipName = `app-${manifest.id}-${version}.zip`;
const zipPath = path.join(outDir, zipName);

fs.mkdirSync(outDir, { recursive: true });
const entries = buildEntries();
const zip = zipEntries(entries);
fs.writeFileSync(zipPath, zip);

const sha256 = crypto.createHash("sha256").update(zip).digest("hex");
const size = zip.length;

const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const permissions = manifest.capabilities.map((capability) => ({
  capability,
  reason: {
    "app/process.spawn": "启动 PowerShell（系统语音合成与播放）和 Python 助手（模型安装、服务启停）。",
    "app/media.provide": "把插件注册成宿主的语音合成供应商，宿主的多媒体入口才能调用。",
    "app/media.generate": "通过宿主的多媒体通道发起语音合成任务并等待结果。",
    "app/resources.read": "调用宿主的原生文件夹选择器，让用户选择本地模型的数据目录。",
  }[capability] || "",
}));

const item = {
  kind: "app",
  id: manifest.id,
  name: manifest.name,
  publisher: PUBLISHER,
  description: "Hana Agent 本地语音朗读V2APP：支持 Windows 系统语音，也支持本机跑的 Kokoro 中文模型，推理全程离线，音频不出本机。",
  version,
  versions: [
    {
      version,
      minAppVersion: manifest.minAppVersion,
      archive: { url: `{{BASE_URL}}/${zipName}`, sha256, size, format: "zip" },
    },
  ],
  archive: { url: `{{BASE_URL}}/${zipName}`, sha256, size, format: "zip" },
  permissions,
  compatibility: { minAppVersion: manifest.minAppVersion, formFactors: ["desktop"] },
  homepage: REPO_URL,
  repository: REPO_URL,
  license: "Apache-2.0",
  categories: ["语音合成", "效率工具"],
  keywords: ["TTS", "朗读", "语音合成", "Kokoro", "离线", "Windows"],
  readme,
  stats: { downloads: 0 },
};

const entryPath = path.join(outDir, `app-${manifest.id}-${version}.entry.json`);
fs.writeFileSync(entryPath, `${JSON.stringify(item, null, 2)}\n`);

const index = {
  schemaVersion: 2,
  sourceId: manifest.id,
  name: manifest.name,
  publishedAt: new Date().toISOString(),
  items: [
    {
      ...item,
      versions: item.versions.map((v) => ({ ...v, archive: { ...v.archive, url: `${BASE_URL}/${zipName}` } })),
      archive: { ...item.archive, url: `${BASE_URL}/${zipName}` },
    },
  ],
};

const validate = await loadMarketValidator();
const result = validate(index);
const indexPath = path.join(outDir, "index.v2.json");
if (result.errors) {
  console.error("市场索引自检失败：", result.errors);
  process.exitCode = 1;
} else {
  fs.writeFileSync(indexPath, `${JSON.stringify(result.index, null, 2)}\n`);
  if (result.warnings && result.warnings.length) {
    console.error("市场索引自检有警告（按官方规则视为失败）：", result.warnings);
    process.exitCode = 1;
  }
}

fs.writeFileSync(path.join(outDir, "SHA256SUMS.txt"), `${sha256}  ${zipName}\n`);

console.log(`zip      ${zipPath}`);
console.log(`         ${entries.length} 个文件，${size} 字节`);
console.log(`sha256   ${sha256}`);
console.log(`entry    ${entryPath}`);
console.log(`index    ${indexPath}`);
console.log(`自检     ${result.errors ? "失败" : "通过"}`);
