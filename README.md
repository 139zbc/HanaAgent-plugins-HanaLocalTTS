# Hana 本地语音朗读 App

一个 Hana v2 App：把聊天内容读出声，先系统语音，后本地模型，最终注册成 Hana 的语音合成供应商。

## 这是什么

- 消息上的"朗读"按钮，点击后用 Windows 系统语音读出消息内容
- 后续支持本地 OpenAI 兼容 TTS 服务（Kokoro、GPT-SoVITS 等）
- 目标：通过 `registerAdapter` 注册成 Hana 多媒体的语音合成供应商

## 当前状态

M1 骨架在 `hana-local-tts/`：清单、图标、卡片封面和一页“已加载”面板。完整计划见 [PLAN.md](PLAN.md)。

下一步：M2 — 消息上的“朗读”按钮，用 Windows 系统语音读出来。

## 开发约定

- 每完成一个里程碑用 Git 提交一次
- 让 AI 写代码时，只交代当前里程碑 + 验收标准
