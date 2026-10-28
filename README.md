# Hana 本地语音朗读 App

一个 Hana v2 App：把聊天内容读出声。可以用 Windows 系统语音，也可以用本机的 Kokoro 中文模型。它已经注册成 Hana 的语音合成供应商。

## 这是什么

- 助手消息上有「朗读」按钮。
- 设置里选「朗读来源」：Windows 系统语音，或本地 Kokoro。
- 两种来源都能选声音、调语速（0.5–2 倍）。Kokoro 有英文声音 Maple、Sol、Vale，以及中文女声、中文男声。语速滑杆松开就保存。
- 通过 `registerAdapter` 注册成 Hana 多媒体的语音合成供应商。

## 当前状态

设置页把模型、CPU 运行环境、GPU 运行环境分开显示。状态用「具备」和「未下载」。同一时间只跑一套；已经下好的那套，切换时不再下载。

本地模型装在 `D:\ProgramData\OH-WorkSpace\hanako\kokoro-zh`，不在这个 Git 仓库里。服务脚本的存档副本是 [kokoro/server.py](kokoro/server.py)。正在跑的那份在模型目录里，改脚本时两份要一起改。

完整计划见 [PLAN.md](PLAN.md)。

改完插件后，把 `hana-local-tts` 复制到 `C:\Users\Fantasy\.hanako\apps\hana-local-tts`，Hana 里打开的才是这份。

下一步：重新加载这个 App。模型只下要用的文件（config + 权重 + 当前选中的那一个声音），换声音时再补下那一个；依赖安装的进度条会报真实字节和速度，卡住会自己重试。设一个新建的空目录（如 `D:\tmp\hana-local-tts\kokoro3`）点「模型 → 下载」和「CPU 运行环境 → 下载」，确认两个阶段的进度都看得见。

## 开发约定

- 每完成一个里程碑用 Git 提交一次
- 让 AI 写代码时，只交代当前里程碑 + 验收标准
- 图片、音频、视频不进 Git
