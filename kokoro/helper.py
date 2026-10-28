"""Kokoro 助手的命令行入口。

App 进程受 Node 权限模型限制：只能读安装目录和自己的 app-data，读不到用户选的
安装目录，也不能自己连本机端口。所以碰盘、碰端口的活都交给这个助手做，Node 只负责
调度和解析结果。

约定：每次调用只往 stdout 写一行 JSON，出错写 stderr 并以非零码退出。
"""

import ctypes
import json
import os
import re
import shutil
import subprocess
import sys
import time
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


def cmd_sync(argv):
    """把 App 数据目录里的 server.py / install.py 同步到安装目录。

    服务代码会随 App 升级，每次开服务前先同步一遍，免得跑的还是老代码。
    """
    args, rest = parse_args(argv)
    root = os.path.abspath(args.get("root") or ".")
    app_dir = os.path.abspath(args.get("app-dir") or ".")
    os.makedirs(root, exist_ok=True)
    copied = []
    for name in ("server.py", "install.py"):
        source_file = os.path.join(app_dir, name)
        if not os.path.isfile(source_file):
            continue
        shutil.copy2(source_file, os.path.join(root, name))
        copied.append(name)
    emit({"synced": copied, "root": root})


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
        # CREATE_NO_WINDOW：不给它控制台，下载时不会闪黑窗口。
        flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
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
        shell = powershell_exe()
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


def venv_python(root: str, device: str) -> str:
    """找到这套设备该用的解释器：新环境用 .venv-cpu/.venv-cuda，老的 .venv 看 torch 认。"""
    folder = ".venv-cuda" if device == "cuda" else ".venv-cpu"
    named = os.path.join(root, folder, "Scripts", "python.exe")
    if os.path.isfile(named):
        return named
    legacy = os.path.join(root, ".venv")
    if legacy_device(legacy) == device:
        candidate = os.path.join(legacy, "Scripts", "python.exe")
        if os.path.isfile(candidate):
            return candidate
    return ""


def service_state() -> dict:
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


def pid_alive(pid: int) -> bool:
    if not pid:
        return False
    try:
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, int(pid))
    except Exception:
        return False
    if not handle:
        return False
    ctypes.windll.kernel32.CloseHandle(handle)
    return True


def wait_pid_exit(pid: int) -> None:
    """等一个进程自己退出。不轮询，直接等内核通知。"""
    if not pid:
        return
    handle = ctypes.windll.kernel32.OpenProcess(0x00100000, False, int(pid))
    if not handle:
        return
    try:
        ctypes.windll.kernel32.WaitForSingleObject(handle, 0xFFFFFFFF)
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def start_service(root: str, device: str, wait: bool = True, temp_dir: str = "") -> dict:
    state = service_state()
    if state["running"]:
        return {"started": False, "running": True, "device": state["device"], "pid": 0}
    python = venv_python(root, device)
    if not python:
        fail("当前选择的运行环境未下载。")
    server = os.path.join(root, "server.py")
    if not os.path.isfile(server):
        fail("安装目录里没有 server.py，请重新安装。")
    tmp = os.path.join(root, "tmp")
    os.makedirs(tmp, exist_ok=True)
    env = os.environ.copy()
    env["KOKORO_DEVICE"] = device
    env["HF_HUB_CACHE"] = os.path.join(root, "hf-cache")
    env["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
    # 临时目录默认放在安装目录里；也可以指到别处（装依赖时目录可能不让写）。
    temp_root = os.path.abspath(temp_dir) if temp_dir else tmp
    try:
        os.makedirs(temp_root, exist_ok=True)
    except OSError:
        temp_root = tmp
    env["TEMP"] = temp_root
    env["TMP"] = temp_root
    model = os.path.join(root, "hf-cache", MODEL_DIR, "snapshots", "installed", MODEL_FILE)
    if os.path.isfile(model):
        env["HF_HUB_OFFLINE"] = "1"
    out = open(os.path.join(tmp, "server.log"), "a", encoding="utf-8")
    err = open(os.path.join(tmp, "server.err"), "a", encoding="utf-8")
    flags = 0
    if os.name == "nt":
        # CREATE_NO_WINDOW：服务不能弹控制台。DETACHED_PROCESS 会给它单开一个
        # 控制台（CREATE_NO_WINDOW 会被忽略），反而会看到黑窗口。
        flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    process = subprocess.Popen(
        [python, server],
        cwd=root,
        env=env,
        stdout=out,
        stderr=err,
        creationflags=flags,
        close_fds=True,
    )
    if not wait:
        return {"started": True, "running": False, "device": device, "pid": process.pid}
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        state = service_state()
        if state["running"]:
            return {"started": True, "running": True, "device": state["device"], "pid": process.pid}
        if process.poll() is not None:
            tail = ""
            for name in ("server.err", "server.log"):
                path = os.path.join(tmp, name)
                if os.path.isfile(path):
                    try:
                        with open(path, "r", encoding="utf-8", errors="replace") as handle:
                            lines = [line.strip() for line in handle.read().splitlines() if line.strip()]
                        if lines:
                            tail = lines[-1]
                            break
                    except OSError:
                        pass
            fail("本地 Kokoro 启动超时。" + (tail if tail else ""))
        time.sleep(0.5)
    fail("本地 Kokoro 启动超时。请再点一次朗读。")


def _service_pids_by_command(root: str) -> list:
    """按命令行找跑着这个目录 server.py 的进程。

    服务升级前启动的老进程没有 pid 文件，也不懂 /shutdown，只能这样扫。
    """
    needle = os.path.abspath(root).replace("'", "''")
    script = (
        "$ids = @(Get-CimInstance Win32_Process -Filter \"Name = 'python.exe'\" -ErrorAction SilentlyContinue "
        "| Where-Object { $_.CommandLine -and $_.CommandLine -like '*%s*' } "
        "| Select-Object -ExpandProperty ProcessId); $ids -join ','" % needle
    )
    try:
        result = subprocess.run(
            [powershell_exe(), "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=30,
        )
    except Exception:
        return []
    pids = []
    for item in (result.stdout or "").strip().split(","):
        item = item.strip()
        if item.isdigit():
            pids.append(int(item))
    return pids


def stop_service(root: str) -> dict:
    """先请服务自己退；不行再按 pid 文件杀进程树；还不行就按命令行扫。"""
    stopped = []
    try:
        request = urllib.request.Request(
            "http://127.0.0.1:%d/shutdown" % PORT, method="POST", data=b"",
        )
        urllib.request.urlopen(request, timeout=5).read()
        stopped.append("shutdown")
    except Exception:
        pass
    pid_file = os.path.join(root, "kokoro.pid")
    pid = 0
    try:
        with open(pid_file, "r", encoding="utf-8") as handle:
            pid = int((handle.read() or "0").strip() or 0)
    except (OSError, ValueError):
        pid = 0
    if pid and pid_alive(pid):
        if not _taskkill(pid):
            _stop_process(pid)
        stopped.append(str(pid))
    try:
        os.remove(pid_file)
    except OSError:
        pass
    if service_state()["running"]:
        # 服务还在：可能是升级前的老进程，按命令行找出来杀掉。
        for other in _service_pids_by_command(root):
            if not _taskkill(other):
                _stop_process(other)
            stopped.append(str(other))
    return {"stopped": stopped}


def _taskkill(pid: int) -> bool:
    try:
        result = subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, text=True, timeout=30,
        )
    except Exception:
        return False
    return result.returncode == 0


def _stop_process(pid: int) -> bool:
    script = "Stop-Process -Id %d -Force -ErrorAction SilentlyContinue" % int(pid)
    try:
        result = subprocess.run(
            [powershell_exe(), "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=30,
        )
    except Exception:
        return False
    return result.returncode == 0


def cmd_start(argv):
    args, rest = parse_args(argv)
    root = os.path.abspath(args.get("root") or ".")
    device = args.get("device") or "cpu"
    wait = (args.get("wait") or "1").lower() not in ("0", "false", "no")
    emit(start_service(root, device, wait=wait, temp_dir=args.get("temp-dir") or ""))


def cmd_stop(argv):
    args, rest = parse_args(argv)
    root = os.path.abspath(args.get("root") or ".")
    emit(stop_service(root))


def cmd_watch(argv):
    """守着 Hana 主进程：它退出就把本地 Kokoro 停掉。"""
    args, rest = parse_args(argv)
    root = os.path.abspath(args.get("root") or ".")
    flag = args.get("flag") or ""
    pid_file = args.get("pid-file") or ""
    if pid_file:
        # 记下自己的进程号，App 那边要停守护进程时用得上。
        try:
            with open(pid_file, "w", encoding="utf-8") as handle:
                handle.write(str(os.getpid()))
        except OSError:
            pass
    wait_pid_exit(int(args.get("pid") or 0))
    if flag and not os.path.isfile(flag):
        # 用户把「自动停止」关了，就不动服务。
        return
    try:
        stop_service(root)
    except Exception:
        pass
    if pid_file:
        try:
            os.remove(pid_file)
        except OSError:
            pass


def _kill_legacy_watchers() -> int:
    """干掉旧版本留下的 PowerShell 守护进程（认 kokoro-watch.ps1）。"""
    script = (
        "$ids = @(Get-CimInstance Win32_Process -Filter \"Name = 'powershell.exe'\" -ErrorAction SilentlyContinue "
        "| Where-Object { $_.CommandLine -and $_.CommandLine -like '*kokoro-watch.ps1*' } "
        "| Select-Object -ExpandProperty ProcessId); "
        "foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }; $ids.Count"
    )
    try:
        result = subprocess.run(
            [powershell_exe(), "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=30,
        )
    except Exception:
        return 0
    try:
        return int((result.stdout or "").strip() or 0)
    except ValueError:
        return 0


def cmd_watch_stop(argv):
    """停掉守护进程：按它写的进程号杀整棵树。"""
    args, rest = parse_args(argv)
    pid_file = args.get("pid-file") or ""
    pid = 0
    try:
        with open(pid_file, "r", encoding="utf-8") as handle:
            pid = int((handle.read() or "0").strip() or 0)
    except (OSError, ValueError):
        pid = 0
    stopped = False
    if pid and pid_alive(pid):
        stopped = _taskkill(pid) or _stop_process(pid)
    try:
        os.remove(pid_file)
    except OSError:
        pass
    legacy = _kill_legacy_watchers()
    emit({"stopped": stopped, "pid": pid, "legacy": legacy})


def cmd_alive(argv):
    args, rest = parse_args(argv)
    emit({"alive": pid_alive(int(args.get("pid") or 0))})


def cmd_live(argv):
    emit(service_state())


def cmd_speak(argv):
    """让本地 Kokoro 合成一段话，结果写成 wav 文件。"""
    args, rest = parse_args(argv)
    root = os.path.abspath(args.get("root") or ".")
    device = args.get("device") or "cpu"
    text_file = os.path.abspath(args.get("text-file") or "")
    out_file = os.path.abspath(args.get("out") or "")
    voice = args.get("voice") or ""
    speed = args.get("speed") or "1"
    with open(text_file, "r", encoding="utf-8") as handle:
        text = handle.read().strip()
    state = service_state()
    if not state["running"]:
        state = start_service(root, device, wait=True)
    payload = json.dumps({"input": text, "voice": voice, "speed": float(speed)}).encode("utf-8")
    request = urllib.request.Request(
        "http://127.0.0.1:%d/v1/audio/speech" % PORT,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        audio = response.read()
    with open(out_file, "wb") as handle:
        handle.write(audio)
    emit({"ok": True, "bytes": len(audio), "device": state.get("device", "")})


def powershell_exe() -> str:
    system_root = os.environ.get("SystemRoot") or r"C:\Windows"
    return os.path.join(system_root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")


def find_process_by_name(name: str) -> int:
    """按进程名找 pid。先问 PowerShell（能看启动时间），不行再问 tasklist。"""
    pid = _find_by_powershell(name)
    if pid:
        return pid
    return _find_by_tasklist(name)


def _find_by_tasklist(name: str) -> int:
    try:
        result = subprocess.run(
            ["tasklist", "/fo", "csv", "/nh"], capture_output=True, text=True, timeout=20,
        )
    except Exception:
        return 0
    for line in (result.stdout or "").splitlines():
        parts = [item.strip().strip('"') for item in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == name.lower():
            try:
                return int(parts[1])
            except ValueError:
                return 0
    return 0


def _find_by_powershell(name: str) -> int:
    """找 Hana 主进程的 pid。

    机器上常有多个同名进程（主进程 + 渲染进程）。要盯的是那一堆里的根，
    不然渲染进程先退，服务就被停了。
    """
    base = name[:-4] if name.lower().endswith(".exe") else name
    # 先找进程树里的根：父进程不在这一堆里的那个。
    script = (
        "$all = @(Get-CimInstance Win32_Process -Filter \"Name = '%s.exe'\" -ErrorAction SilentlyContinue); "
        "$ids = @($all | Select-Object -ExpandProperty ProcessId); "
        "$roots = @($all | Where-Object { $ids -notcontains $_.ParentProcessId }); "
        "if ($roots.Count -eq 0) { $roots = $all }; "
        "($roots | Sort-Object CreationDate | Select-Object -First 1).ProcessId" % base
    )
    pid = _run_powershell_pid(script)
    if pid:
        return pid
    # 退一步：找启动最早的那个。
    script = (
        "(Get-Process -Name '%s' -ErrorAction SilentlyContinue | "
        "Sort-Object StartTime | Select-Object -First 1 -ExpandProperty Id)" % base
    )
    return _run_powershell_pid(script)


def _run_powershell_pid(script: str) -> int:
    try:
        result = subprocess.run(
            [powershell_exe(), "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=25,
        )
    except Exception:
        return 0
    try:
        pid = int((result.stdout or "").strip())
    except ValueError:
        return 0
    return pid if pid > 0 else 0


def cmd_hana_pid(argv):
    emit({"pid": find_process_by_name("HanaAgent.exe")})


COMMANDS = {
    "probe": cmd_probe,
    "install": cmd_install,
    "sync": cmd_sync,
    "gpu": cmd_gpu,
    "voice": cmd_voice,
    "start": cmd_start,
    "stop": cmd_stop,
    "watch": cmd_watch,
    "watch-stop": cmd_watch_stop,
    "alive": cmd_alive,
    "live": cmd_live,
    "speak": cmd_speak,
    "hana-pid": cmd_hana_pid,
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
