// 冒烟测试：mock sdk，直接驱动 registerSpeechProvider + registerRoutes，
// 再执行每个 GET handler，验证路由体里没有漏 import 的名字（漏了会抛 ReferenceError）。
import { registerSpeechProvider, setSystemVoiceCache } from "../lib/speech.js";
import { registerRoutes } from "../lib/routes.js";

const calls = [];
const logger = {
  info: (m) => calls.push(["info", String(m).slice(0, 100)]),
  error: (m) => calls.push(["error", String(m).slice(0, 160)]),
  warn: (m) => calls.push(["warn", m]),
};

const registeredRoutes = new Map();
const sdk = {
  logger,
  dataDir: "D:/tmp/hana-local-tts-test-data",
  config: {
    getAll: async () => ({}),
    setMany: async () => ({}),
  },
  process: {
    resolveExecutable: async () => null,
  },
  media: {
    registerAdapter: async () => {},
    registerCapabilitySource: async () => {},
    getTask: async () => null,
  },
  bus: {
    request: async () => ({}),
  },
};

setSystemVoiceCache([]);
await registerSpeechProvider(sdk);
await registerRoutes(sdk, {
  get: (p, h) => registeredRoutes.set("GET " + p, h),
  post: (p, h) => registeredRoutes.set("POST " + p, h),
  put: (p, h) => registeredRoutes.set("PUT " + p, h),
});
console.log("registered routes:", registeredRoutes.size);

const c = {
  req: { json: async () => ({}) },
  json: (data, status) => ({ ok: true, data, status }),
};

let ran = 0;
const total = registeredRoutes.size;
for (const [key, handler] of registeredRoutes) {
  try {
    await handler(c);
  } catch (error) {
    if (/is not defined/i.test(String(error))) {
      console.error("ROUTE FAIL", key, "->", String(error).slice(0, 200));
      process.exit(1);
    }
    // 其他错误（mock 环境下找不到 PowerShell/Python）属正常，走的也是真实代码路径
  }
  ran += 1;
}
console.log(`all handlers executed: ${ran}/${total}`);
console.log("smoke ok");
