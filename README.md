# Hana 本地语音朗读 App

一个 Hana v2 App：把聊天内容读出声。可以用 Windows 系统语音，也可以用本机的 Kokoro 中文模型。它已经注册成 Hana 的语音合成供应商。

## 这是什么

- 助手消息上有「朗读」按钮。
- 设置里选「朗读来源」：Windows 系统语音，或本地 Kokoro。
- 两种来源都能选声音、调语速（0.5–2 倍）。Kokoro 有英文声音 Maple、Sol、Vale，以及中文女声、中文男声。语速滑杆松开就保存。
- 通过 `registerAdapter` 注册成 Hana 多媒体的语音合成供应商。

## 当前状态

M5 已通过。来源选「本地 Kokoro」，可以换声音、调语速，再点「朗读」。句子里的英文也会读。

本地模型装在 `D:\ProgramData\OH-WorkSpace\hanako\kokoro-zh`，不在这个 Git 仓库里。服务脚本的存档副本是 [kokoro/server.py](kokoro/server.py)。正在跑的那份在模型目录里，改脚本时两份要一起改。

完整计划见 [PLAN.md](PLAN.md)。

下一步：M7，设置页只显示 Kokoro 装没装好、服务开没开、安装路径、当前是 CPU。一键安装和 GPU 切换放在后面。计划见 [PLAN.md](PLAN.md)。

## 开发约定

- 每完成一个里程碑用 Git 提交一次
- 让 AI 写代码时，只交代当前里程碑 + 验收标准
- 图片、音频、视频不进 Git
