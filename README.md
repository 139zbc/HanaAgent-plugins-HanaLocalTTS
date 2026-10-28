# Hana 本地语音朗读 App

一个 Hana v2 App：把聊天内容读出声。可以用 Windows 系统语音，也可以用本机的 Kokoro 中文模型。它已经注册成 Hana 的语音合成供应商。

## 这是什么

- 助手消息上有「朗读」按钮。
- 设置里选「朗读来源」：Windows 系统语音，或本地 Kokoro。
- 两种来源都能选声音、调语速（0.5–2 倍）。Kokoro 有英文声音 Maple、Sol、Vale，以及中文女声、中文男声。语速滑杆松开就保存。
- 通过 `registerAdapter` 注册成 Hana 多媒体的语音合成供应商。

## 当前状态

设置页把模型、CPU 运行环境、GPU 运行环境分开显示。状态用「具备」和「未下载」。同一时间只跑一套；已经下好的那套，切换时不再下载。

服务启停已经搬到 Python 助手：Node 只管调度，拉服务、停服务、守着 Hana 退出自动停服务，全由助手（子进程）做。系统语音合成和播放仍走 PowerShell（Node 没有 .NET/SAPI）。

本地模型装在 `D:\ProgramData\OH-WorkSpace\hanako\kokoro-zh`，不在这个 Git 仓库里。服务脚本的存档副本是 [kokoro/server.py](kokoro/server.py)。正在跑的那份在模型目录里，改脚本时两份要一起改。

完整计划见 [PLAN.md](PLAN.md)。

改完插件后，把 `hana-local-tts` 复制到 `C:\Users\Fantasy\.hanako\apps\hana-local-tts`，Hana 里打开的才是这份。

下一步：重新加载这个 App，确认「启动 / 停止」按钮正常、停完不留 `server.py` 进程、关掉 Hana 后服务自己停。然后做 M14-4——首装自动下载 Python 3.12.14 到 app-data（`curl.exe` 下载 + `tar.exe` 解包），设置页加一行「Python 运行环境」。

## 开发约定

- 每完成一个里程碑用 Git 提交一次
- 让 AI 写代码时，只交代当前里程碑 + 验收标准
- 图片、音频、视频不进 Git
