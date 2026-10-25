# Hana 本地语音朗读 App

一个 Hana v2 App：把聊天内容读出声。可以用 Windows 系统语音，也可以用本机的 Kokoro 中文模型。它已经注册成 Hana 的语音合成供应商。

## 这是什么

- 助手消息上有「朗读」按钮。
- 设置里选「朗读来源」：Windows 系统语音，或本地 Kokoro（中文）。
- 系统语音可以选声音、调语速（0.5–2 倍）。Kokoro 目前固定声音 `zf_094`，语速仍可调。
- 通过 `registerAdapter` 注册成 Hana 多媒体的语音合成供应商。

## 当前状态

M5 已通过。来源选「本地 Kokoro（中文）」再点「朗读」，听到的是本机 Kokoro，句子里的英文也会读。

本地模型装在 `D:\ProgramData\OH-WorkSpace\hanako\kokoro-zh`，不在这个 Git 仓库里。服务脚本的存档副本是 [kokoro/server.py](kokoro/server.py)。正在跑的那份在模型目录里，改脚本时两份要一起改。

完整计划见 [PLAN.md](PLAN.md)。

下一步：Kokoro 的声音目前不能在设置里换。要换别的声音时再做。

## 开发约定

- 每完成一个里程碑用 Git 提交一次
- 让 AI 写代码时，只交代当前里程碑 + 验收标准
- 图片、音频、视频不进 Git
