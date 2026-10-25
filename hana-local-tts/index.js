import { defineApp } from "./sdk/app-contract/server-client.js";

export const name = "hana-local-tts";

export default defineApp(async (sdk) => {
  await sdk.logger.info("hana-local-tts loaded");

  await sdk.tools.register({
    name: "hana_local_tts_status",
    description: "报告本地语音朗读 App 是否已加载。现在还不能朗读。",
    parameters: { type: "object", properties: {} },
    execute: async () => ({
      content: [{ type: "text", text: "本地语音朗读已加载。朗读功能还没做。" }],
    }),
  });
});
