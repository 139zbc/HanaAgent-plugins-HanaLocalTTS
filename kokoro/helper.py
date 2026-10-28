"""Kokoro 助手的命令行入口。

App 进程受 Node 权限模型限制：只能读安装目录和自己的 app-data，读不到用户选的
安装目录，也不能自己连本机端口。所以碰盘、碰端口的活都交给这个助手做，Node 只负责
调度和解析结果。

约定：每次调用只往 stdout 写一行 JSON，出错写 stderr 并以非零码退出。
"""

import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request

PORT = int(os.environ.get("KOKORO_PORT", "8765"))
MODEL_DIR = "models--hexgrad--Kokoro-82M-v1.1-zh"
MODEL_FILE = "kokoro-v1_1-zh.pth"
ACTIVE_PHASES = ("venv", "deps", "torch", "model", "verify")
# 声音文件按需补下：换声音时只下这一个，放回 HF 缓存布局的 installed 快照里。
VOICE_RE = re.compile(r"^[a-z]{2}_\d{3}$")
VOICE_SOURCES = (
    ("modelscope", "https://modelscope.cn/models/AI-ModelScope/Kokoro-82M-v1.1-zh/resolve/master/voices/%s.pt"),
    ("hf-mirror", "https://hf-mirror.com/hexgrad/Kokoro-82M-v1.1-zh/resolve/main/voices/%s.pt"),
    ("huggingface", "https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/resolve/main/voices/%s.pt"),
)
# 一个真的声音包约 523KB；小到这个数以下肯定是错误页/空文件。
MIN_VOICE_BYTES = 100_000


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def fail(message):
    sys.stderr.write(str(message) + "\n")
    sys.exit(1)


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def marked_device(venv):
    """新环境只认 runtime.json：没写完就不算具备。"""
    marker = read_json(os.path.join(venv, "runtime.json"))
    if not isinstance(marker, dict):
        return ""
    device = str(marker.get("device") or "")
    return device if device in ("cpu", "cuda") else ""


def legacy_device(venv):
    """旧环境（.venv）没有 runtime.json，按装着的 torch 判断。"""
    marker = read_json(os.path.join(venv, "runtime.json"))
    if isinstance(marker, dict):
        device = str(marker.get("device") or "")
        if device in ("cpu", "cuda"):
            return device
    site = os.path.join(venv, "Lib", "site-packages")
    if not os.path.isdir(site):
        return ""
    try:
        names = os.listdir(site)
    except OSError:
        return ""
    for name in names:
        if name.startswith("torch-") and name.endswith(".dist-info"):
            return "cuda" if "+cu" in name else "cpu"
    return ""


def model_ready(root):
    cache = os.path.join(root, "hf-cache", MODEL_DIR, "snapshots")
    if os.path.isfile(os.path.join(cache, "installed", MODEL_FILE)):
        return True
    if not os.path.isdir(cache):
        return False
    try:
        names = os.listdir(cache)
    except OSError:
        return False
    for name in names:
        if os.path.isfile(os.path.join(cache, name, MODEL_FILE)):
            return True
    return False


def dir_gb(root):
    total = 0
    for base, _dirs, files in os.walk(root):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(base, name))
            except OSError:
                pass
    return round(total / (1024 ** 3), 1)


def service_state():
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/health" % PORT, timeout=2) as response:
            body = json.loads(response.read().decode("utf-8"))
    except Exception:
        return {"running": False, "device": "", "root": ""}
    if not isinstance(body, dict):
        return {"running": False, "device": "", "root": ""}
    return {
        "running": True,
        "device": str(body.get("device") or ""),
        "root": str(body.get("root") or ""),
    }


def same_path(left, right):
    try:
        return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right))
    except (OSError, ValueError):
        return False


def parse_args(argv):
    """支持 --key value 和位置参数两种写法。"""
    parsed = {}
    rest = []
    index = 0
    while index < len(argv):
        item = argv[index]
        if item.startswith("--"):
            key = item[2:]
            if "=" in key:
                name, value = key.split("=", 1)
                parsed[name] = value
            elif index + 1 < len(argv):
                parsed[key] = argv[index + 1]
                index += 1
            else:
                parsed[key] = ""
        else:
            rest.append(item)
        index += 1
    return parsed, rest


def cmd_probe(argv):
    args, rest = parse_args(argv)
    root = os.path.abspath(args.get("root") or (rest[0] if rest else "."))
    cpu = marked_device(os.path.join(root, ".venv-cpu")) == "cpu"
    gpu = marked_device(os.path.join(root, ".venv-cuda")) == "cuda"
    legacy = legacy_device(os.path.join(root, ".venv"))
    if not cpu:
        cpu = legacy == "cpu"
    if not gpu:
        gpu = legacy == "cuda"
    model = model_ready(root)
    state = read_json(os.path.join(root, "install-state.json"))
    if isinstance(state, dict):
        phase = str(state.get("phase") or "")
        component = str(state.get("component") or "")
        if phase and phase not in ("done", "failed", "none"):
            if component == "model":
                model = False
            elif component == "cpu":
                cpu = False
            elif component == "gpu":
                gpu = False
    service = service_state()
    foreign = service["running"] and service["root"] and not same_path(service["root"], root)
    emit({
        "model": model,
        "cpu": cpu,
        "gpu": gpu,
        "dirGB": dir_gb(root) if os.path.isdir(root) else None,
        "running": service["running"],
        "device": service["device"],
        # 服务自己报的目录。换过安装路径后它和当前目录不一样，停止时要用它。
        "serviceRoot": service["root"],
        "foreign": foreign,
    })


def cmd_install(argv):
    """把 App 数据目录里的 server.py / install.py 搬进安装目录，再起 install.py。

    Node 进程读不到用户选的安装目录，只能把文件先放进自己的数据目录，
    由这个助手（子进程，不受 Node 权限模型限制）搬过去并启动。
    """
    args, rest = parse_args(argv)
    root = os.path.abspath(args.get("root") or ".")
    app_dir = os.path.abspath(args.get("app-dir") or ".")
    component = args.get("component") or ""
    source = args.get("source") or "modelscope"
    pip_source = args.get("pip-source") or "tuna"
    torch_source = args.get("torch-source") or "nju"
    voice = args.get("voice") or "zf_094"
    if not VOICE_RE.match(voice):
        voice = "zf_094"
    if component not in ("model", "cpu", "gpu"):
        fail("要指定下载模型、CPU 运行环境或 GPU 运行环境。")

    os.makedirs(root, exist_ok=True)
    for name in ("server.py", "install.py"):
        source_file = os.path.join(app_dir, name)
        if not os.path.isfile(source_file):
            fail("缺少 %s，请重新加载 App 再试。" % name)
        shutil.copy2(source_file, os.path.join(root, name))

    log_dir = os.path.join(root, "tmp")
    os.makedirs(log_dir, exist_ok=True)
    log = open(os.path.join(log_dir, "install.log"), "a", encoding="utf-8")
    command = [
        sys.executable,
        os.path.join(root, "install.py"),
        "--root", root,
        "--source", source,
        "--pip-source", pip_source,
        "--torch-source", torch_source,
        "--component", component,
        "--state-dir", app_dir,
        "--voice", voice,
    ]
    flags = 0
    if os.name == "nt":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
    process = subprocess.Popen(
        command,
        cwd=root,
        stdout=log,
        stderr=log,
        creationflags=flags,
        close_fds=True,
    )
    emit({"started": True, "pid": process.pid, "python": sys.executable})


def cmd_gpu(argv):
    """查这台电脑有没有 NVIDIA 显卡。用 nvidia-smi，不行再问系统。"""
    system_root = os.environ.get("SystemRoot") or r"C:\Windows"
    smi = os.path.join(system_root, "System32", "nvidia-smi.exe")
    if os.path.isfile(smi):
        try:
            result = subprocess.run(
                [smi, "--query-gpu=name", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=20,
            )
            if result.stdout and result.stdout.strip():
                emit({"gpu": True})
                return
        except Exception:
            pass
    try:
        shell = os.path.join(system_root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        script = "Get-CimInstance Win32_VideoController | Where-Object { $_.Name -like '*NVIDIA*' } | Select-Object -First 1 -ExpandProperty Name"
        result = subprocess.run(
            [shell, "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=25,
        )
        if result.stdout and result.stdout.strip():
            emit({"gpu": True})
            return
    except Exception:
        pass
    emit({"gpu": False})


def voices_dir(root):
    return os.path.join(root, "hf-cache", MODEL_DIR, "snapshots", "installed", "voices")


def voice_path(root, voice):
    return os.path.join(voices_dir(root), voice + ".pt")


def fetch_voice(url, target, timeout=60):
    """下一个声音文件：先写 .part，验过字节数再原子改名。失败不留残片。"""
    os.makedirs(os.path.dirname(target), exist_ok=True)
    part = target + ".part"
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "hana-local-tts/1.0"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            with open(part, "wb") as handle:
                shutil.copyfileobj(response, handle)
        size = os.path.getsize(part)
        if size < MIN_VOICE_BYTES:
            raise RuntimeError("下到的文件太小（%d 字节），不像声音包" % size)
        os.replace(part, target)
        return size
    finally:
        if os.path.exists(part):
            try:
                os.remove(part)
            except OSError:
                pass


def cmd_voice(argv):
    """确保一个声音文件在本地。已在就直接返回；没有就按源顺序下一个。

    Kokoro 服务跑在离线模式（HF_HUB_OFFLINE=1），它找声音文件就走 HF 缓存的
    installed 快照。把文件放进那个目录，服务不用重启也能找到。
    """
    args, rest = parse_args(argv)
    root = os.path.abspath(args.get("root") or (rest[0] if rest else "."))
    voice = args.get("id") or args.get("voice") or (rest[1] if len(rest) > 1 else "")
    if not VOICE_RE.match(voice or ""):
        fail("声音名不对：%s" % (voice or "（空）"))
    target = voice_path(root, voice)
    if os.path.isfile(target):
        emit({"ready": True, "voice": voice, "downloaded": False})
        return
    preferred = args.get("source") or ""
    order = [item for item in VOICE_SOURCES if item[0] == preferred]
    order += [item for item in VOICE_SOURCES if item[0] != preferred]
    errors = []
    for name, template in order:
        try:
            size = fetch_voice(template % voice, target)
            emit({"ready": True, "voice": voice, "downloaded": True, "source": name, "bytes": size})
            return
        except Exception as error:  # noqa: BLE001 - 换下一个源再试
            errors.append("%s：%s" % (name, error))
    fail("声音文件没下成。" + "；".join(errors))


COMMANDS = {
    "probe": cmd_probe,
    "install": cmd_install,
    "gpu": cmd_gpu,
    "voice": cmd_voice,
}


def main(argv):
    if len(argv) < 2:
        fail("用法：kokoro-helper.py <子命令> [参数]")
    command = COMMANDS.get(argv[1])
    if command is None:
        fail("不认识的子命令：%s" % argv[1])
    command(argv[2:])


if __name__ == "__main__":
    main(sys.argv)
