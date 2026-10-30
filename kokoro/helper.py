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
# 和 kokoro-voices.js 里的 id 用同一条规则：两位字母，加下划线，再加数字或英文名。
# 例如 zf_094、af_maple。对不上就报错，不许改成别的声音。
VOICE_RE = re.compile(r"^[a-z]{2}_[a-z0-9]{2,16}$")
VOICE_SOURCES = (
    ("modelscope", "https://modelscope.cn/models/AI-ModelScope/Kokoro-82M-v1.1-zh/resolve/master/voices/%s.pt"),
    ("hf-mirror", "https://hf-mirror.com/hexgrad/Kokoro-82M-v1.1-zh/resolve/main/voices/%s.pt"),
    ("huggingface", "https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/resolve/main/voices/%s.pt"),
)
# 一个真的声音包约 523KB；小到这个数以下肯定是错误页/空文件。
MIN_VOICE_BYTES = 100_000

# App 自带的便携版 Python（python-build-standalone，uv 用的同款）。
# 官方 3.12.11 之后只发源码没有 Windows 包；官方全量 zip 缺 venvlauncher.exe 建不了 venv。
PYTHON_VERSION = "3.12.16"
PYTHON_BUILD = "20261026"
PYTHON_ARCHIVE = "cpython-%s+%s-x86_64-pc-windows-msvc-install_only.tar.gz" % (PYTHON_VERSION, PYTHON_BUILD)
PYTHON_URLS = (
    "https://registry.npmmirror.com/-/binary/python-build-standalone/%s/%s" % (PYTHON_BUILD, PYTHON_ARCHIVE),
    "https://github.com/astral-sh/python-build-standalone/releases/download/%s/%s" % (PYTHON_BUILD, PYTHON_ARCHIVE),
)
PYTHON_BYTES = 47100000


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


def measure_dirs(root, components):
    """一次遍历算出根目录的总大小和各子目录的大小。

    components 是 [(名字, 目录)] 的列表。子目录的大小不跟随软链：
    HF 缓存的快照里是指向 blobs 的软链，跟着算会算两遍。
    总大小跟旧算法一致（跟随软链），免得 dirGB 变样。
    """
    total = 0
    sizes = {name: 0 for name, _ in components}
    prefixes = [(name, os.path.abspath(path)) for name, path in components if path]
    for base, _dirs, files in os.walk(root):
        for name in files:
            full = os.path.join(base, name)
            try:
                if os.path.islink(full):
                    total += os.path.getsize(full)
                    continue
                size = os.path.getsize(full)
            except OSError:
                continue
            total += size
            for label, prefix in prefixes:
                if full.startswith(prefix + os.sep):
                    sizes[label] += size
                    break
    return total, sizes


def torch_version(venv):
    """环境里装的 torch 版本（带 +cu 的是 CUDA 版）。"""
    if not venv:
        return ""
    site = os.path.join(venv, "Lib", "site-packages")
    try:
        names = os.listdir(site)
    except OSError:
        return ""
    for name in names:
        if name.startswith("torch-") and name.endswith(".dist-info"):
            return name[len("torch-"):-len(".dist-info")]
    return ""


def open_local(request, timeout):
    """访问本机服务时不走系统代理。代理把 127.0.0.1 转走时，健康检查会一直失败。"""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return opener.open(request, timeout=timeout)


def service_state():
    try:
        with open_local("http://127.0.0.1:%d/health" % PORT, 2) as response:
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


def cmd_python_install(argv):
    """把便携版 Python 装到 --dir 指定的目录（下载 + 解压 + 验版本）。

    进度写到 <state-dir>/python-state.json，App 那边轮询这个文件。
    """
    args, rest = parse_args(argv)
    target = os.path.abspath(args.get("dir") or "")
    state_dir = os.path.abspath(args.get("state-dir") or os.path.dirname(target))
    if not target:
        fail("要指定 Python 装到哪。")
    emit(install_python(target, state_dir))


def write_python_state(state_dir, payload):
    try:
        os.makedirs(state_dir, exist_ok=True)
        with open(os.path.join(state_dir, "python-state.json"), "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
    except OSError:
        pass


def python_version_of(executable):
    try:
        result = subprocess.run(
            [executable, "-c", "import sys;print('%d.%d.%d' % sys.version_info[:3])"],
            capture_output=True, text=True, timeout=30,
        )
    except Exception:
        return ""
    lines = (result.stdout or "").strip().splitlines()
    return lines[-1].strip() if lines else ""


def install_python(target_dir, state_dir):
    """下载并解压便携版 Python。解压后是 target_dir/python.exe。"""
    exe = os.path.join(target_dir, "python.exe")
    if os.path.isfile(exe):
        version = python_version_of(exe)
        if version.startswith("3.12"):
            write_python_state(state_dir, {
                "phase": "done", "percent": 100, "version": version,
                "message": "已经有 %s 了。" % version,
            })
            return {"installed": True, "version": version, "path": exe, "downloaded": False}
    os.makedirs(target_dir, exist_ok=True)
    tmp_dir = os.path.join(state_dir, "tmp")
    os.makedirs(tmp_dir, exist_ok=True)
    archive = os.path.join(tmp_dir, "python.tar.gz")
    errors = []
    ok = False
    for url in PYTHON_URLS:
        write_python_state(state_dir, {
            "phase": "downloading", "percent": 0, "message": "正在下载 Python %s…" % PYTHON_VERSION,
        })
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "hana-local-tts/1.0"})
            with urllib.request.urlopen(request, timeout=180) as response:
                total = int(response.headers.get("Content-Length") or 0)
                done = 0
                started = time.monotonic()
                last = 0.0
                with open(archive, "wb") as handle:
                    while True:
                        chunk = response.read(262144)
                        if not chunk:
                            break
                        handle.write(chunk)
                        done += len(chunk)
                        now = time.monotonic()
                        if now - last >= 0.3:
                            last = now
                            speed = done / max(now - started, 0.001)
                            percent = int(done * 100 / total) if total else 0
                            write_python_state(state_dir, {
                                "phase": "downloading",
                                "percent": percent,
                                "bytes": done,
                                "total": total or PYTHON_BYTES,
                                "speed": speed,
                                "message": "已下 %.1f / %.1f MB · %.1f MB/秒" % (
                                    done / 1048576, max(total, done) / 1048576, speed / 1048576),
                            })
            ok = True
            break
        except Exception as error:  # noqa: BLE001 - 换下一个源再试
            errors.append("%s：%s" % (url.split("/")[2], error))
    if not ok:
        message = "Python 没下成。" + "；".join(errors)
        write_python_state(state_dir, {"phase": "failed", "percent": 0, "message": message})
        fail(message)
    write_python_state(state_dir, {"phase": "extracting", "percent": 95, "message": "正在解压…"})
    try:
        import tarfile
        with tarfile.open(archive, "r:gz") as tar:
            # 压缩包顶层就是 python/，解压到 app-data 里正好落在 app-data/python。
            tar.extractall(os.path.dirname(target_dir), filter="data")
    except Exception as error:  # noqa: BLE001
        message = "解压失败：%s" % error
        write_python_state(state_dir, {"phase": "failed", "percent": 0, "message": message})
        fail(message)
    try:
        os.remove(archive)
    except OSError:
        pass
    version = python_version_of(exe)
    if not version.startswith("3.12"):
        message = "解压出来的 Python 版本不对：%s" % (version or "读不到版本")
        write_python_state(state_dir, {"phase": "failed", "percent": 0, "message": message})
        fail(message)
    write_python_state(state_dir, {
        "phase": "done", "percent": 100, "version": version,
        "message": "Python %s 已经装好。" % version,
    })
    return {"installed": True, "version": version, "path": exe, "downloaded": True}


def cmd_check_dir(argv):
    """检查一个目录能不能用：建得出来、写得了、还剩多少空间。

    用户在宿主里挑了一个文件夹，App 要在里面建一个自己的子目录。这个命令提前
    把「建不了/写不了/空间不够」说出来，别等下了 5GB 才发现。
    """
    args, rest = parse_args(argv)
    root = os.path.abspath(args.get("root") or (rest[0] if rest else "."))
    try:
        os.makedirs(root, exist_ok=True)
    except Exception as error:
        fail("建不了这个目录：%s" % error)
    # 写一个临时文件试试真的写得了（目录在但没权限也会栽在这）。
    probe = os.path.join(root, ".hana-write-test")
    try:
        with open(probe, "w", encoding="utf-8") as handle:
            handle.write("ok")
        os.remove(probe)
    except Exception as error:
        fail("这个目录写不了：%s" % error)
    try:
        usage = shutil.disk_usage(root)
        free_bytes = usage.free
        total_bytes = usage.total
    except Exception:
        free_bytes = 0
        total_bytes = 0
    emit({
        "ok": True,
        "root": root,
        "freeBytes": free_bytes,
        "totalBytes": total_bytes,
    })


def dir_size(path):
    """目录里所有文件的字节数。"""
    total = 0
    for base, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(base, name))
            except OSError:
                pass
    return total


def cleanup_temp(temp_dir: str, max_age_minutes: int = 60) -> dict:
    """清掉临时目录里过期的 tmp* 子目录。

    服务每跑一次，phonemizer 会把 espeak-ng.dll 拷一份到 TEMP 里（Windows 上
    它的 atexit 清理不生效，跑一次攒一个 419KB 的目录）。跑得多了就是几十 MB
    的垃圾。

    只删两样都满足的：名字以 tmp 开头、且最后修改时间超过 max_age_minutes。
    正在跑的那个服务刚建目录，删不到；偶尔删不掉（文件正被占用）就跳过。
    jieba.cache、torch 缓存、server.log 这些不在 tmp* 里，不动。
    """
    result = {"tempDir": temp_dir, "removed": 0, "freedBytes": 0}
    if not temp_dir or not os.path.isdir(temp_dir):
        return result
    cutoff = time.time() - max_age_minutes * 60
    try:
        names = os.listdir(temp_dir)
    except OSError:
        return result
    for name in names:
        if not name.startswith("tmp"):
            continue
        full = os.path.join(temp_dir, name)
        if not os.path.isdir(full):
            continue
        try:
            if os.path.getmtime(full) > cutoff:
                continue
            size = dir_size(full)
            shutil.rmtree(full, ignore_errors=True)
            if os.path.isdir(full):
                continue
            result["removed"] += 1
            result["freedBytes"] += size
        except OSError:
            continue
    return result


def cmd_cleanup(argv):
    """清临时目录。"""
    args, rest = parse_args(argv)
    temp_dir = args.get("temp-dir") or ""
    try:
        max_age = int(args.get("max-age-minutes") or 60)
    except (TypeError, ValueError):
        max_age = 60
    result = cleanup_temp(temp_dir, max_age)
    result["ok"] = True
    emit(result)


def cmd_probe(argv):
    args, rest = parse_args(argv)
    root = os.path.abspath(args.get("root") or (rest[0] if rest else "."))
    cpu_venv = os.path.join(root, ".venv-cpu")
    gpu_venv = os.path.join(root, ".venv-cuda")
    legacy_venv = os.path.join(root, ".venv")
    cpu = marked_device(cpu_venv) == "cpu"
    gpu = marked_device(gpu_venv) == "cuda"
    legacy = legacy_device(legacy_venv)
    if not cpu:
        cpu = legacy == "cpu"
    if not gpu:
        gpu = legacy == "cuda"
    # 实际在用的目录：老环境（.venv）只算一份，别把同一份报两次。
    if cpu and marked_device(cpu_venv) != "cpu":
        cpu_venv = legacy_venv if legacy == "cpu" else ""
    if gpu and marked_device(gpu_venv) != "cuda":
        gpu_venv = legacy_venv if legacy == "cuda" else ""
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
    # 三份各自的名字和大小，页面显示「已下载（名字 大小）」。
    model_dir = os.path.join(root, "hf-cache", MODEL_DIR)
    if os.path.isdir(root):
        total, sizes = measure_dirs(root, [
            ("model", model_dir),
            ("cpu", cpu_venv),
            ("gpu", gpu_venv),
        ])
        dir_gb = round(total / (1024 ** 3), 1)
    else:
        sizes = {"model": 0, "cpu": 0, "gpu": 0}
        dir_gb = None
    emit({
        "model": model,
        "cpu": cpu,
        "gpu": gpu,
        "modelName": MODEL_DIR.split("--")[-1],
        "modelBytes": sizes["model"] if model else 0,
        "cpuName": ("PyTorch %s CPU" % torch_version(cpu_venv)).strip() if cpu else "",
        "cpuBytes": sizes["cpu"] if cpu else 0,
        "gpuName": ("PyTorch %s CUDA" % torch_version(gpu_venv)).strip() if gpu else "",
        "gpuBytes": sizes["gpu"] if gpu else 0,
        "dirGB": dir_gb,
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
        fail("声音名不对：%s" % voice)
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
        with open_local("http://127.0.0.1:%d/health" % PORT, 2) as response:
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


def load_token(path: str) -> str:
    """读 App 数据目录里的令牌。短的、空的、不是十六进制的都不算。"""
    data = read_json(path) if path else None
    if not isinstance(data, dict):
        return ""
    token = str(data.get("token") or "")
    if not re.fullmatch(r"[a-f0-9]{64}", token):
        return ""
    return token


def command_line_is_server(command_line: str, root: str) -> bool:
    """命令行里是不是这个数据目录下的 server.py。必须整段路径对上，不用模糊匹配。"""
    if not command_line or not root:
        return False
    server = os.path.normcase(os.path.abspath(os.path.join(root, "server.py")))
    text = os.path.normcase(command_line)
    start = 0
    while True:
        index = text.find(server, start)
        if index < 0:
            return False
        before = text[index - 1] if index else ""
        end = index + len(server)
        after = text[end] if end < len(text) else ""
        if before in ("", " ", "\t", '"', "'") and after in ("", " ", "\t", '"', "'"):
            return True
        start = index + 1


def capture_text(args, timeout: int) -> str:
    """读子进程输出。不用 text=True，避免系统编码对不上时读线程抛错、结果变空。"""
    try:
        result = subprocess.run(args, capture_output=True, timeout=timeout)
    except Exception:
        return ""
    data = result.stdout or b""
    if data.startswith(b"\xff\xfe") or (len(data) >= 8 and data[1] == 0 and data[3] == 0 and data[5] == 0):
        return data.decode("utf-16-le", errors="replace")
    if data.startswith(b"\xfe\xff"):
        return data.decode("utf-16-be", errors="replace")
    for encoding in ("utf-8", "gbk"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def python_process_rows() -> list:
    """本机 python.exe 的 pid、父进程和完整命令行。"""
    script = (
        "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; "
        "$OutputEncoding = [Console]::OutputEncoding; "
        "Get-CimInstance Win32_Process -Filter \"Name = 'python.exe'\" -ErrorAction SilentlyContinue "
        "| Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress"
    )
    raw = capture_text(
        [powershell_exe(), "-NoProfile", "-NonInteractive", "-Command", script],
        30,
    ).strip().lstrip("\ufeff")
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return []
    rows = parsed if isinstance(parsed, list) else [parsed]
    found = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            pid = int(row.get("ProcessId") or 0)
        except (TypeError, ValueError):
            continue
        command = row.get("CommandLine") or ""
        try:
            parent = int(row.get("ParentProcessId") or 0)
        except (TypeError, ValueError):
            parent = 0
        if pid > 0 and isinstance(command, str) and command:
            found.append({"pid": pid, "parent": parent, "command": command})
    return found


def python_processes() -> list:
    """兼容旧调用：只要 pid 和命令行。"""
    return [(row["pid"], row["command"]) for row in python_process_rows()]


def pids_for_server(root: str) -> list:
    return [pid for pid, command in python_processes() if command_line_is_server(command, root)]


def listener_kind(listener: int, root: str, extra_pids=()) -> str:
    """端口上的进程是不是我们这份。

    ours：命令行对得上，或者它是我们刚拉起的那个进程的子进程。
    Windows 虚拟环境会先起 Scripts\\python.exe，再由它拉起真正在听端口的解释器。
    foreign：命令行看得见，但不是这个目录的 server.py。
    unknown：还没看清。这时不能当成别人的服务去关。
    """
    if not listener:
        return "unknown"
    extra = {int(pid) for pid in (extra_pids or []) if pid}
    rows = python_process_rows()
    match = next((row for row in rows if row["pid"] == listener), None)
    if match is None:
        return "ours" if listener in extra else "unknown"
    if command_line_is_server(match["command"], root) or listener in extra or match["parent"] in extra:
        return "ours"
    if match["command"]:
        return "foreign"
    return "unknown"


def listening_pid(port: int) -> int:
    """谁在听这个端口。对不上我们的 server.py 时，不会向它发关闭。"""
    text = capture_text(["netstat", "-ano", "-p", "tcp"], 15)
    suffix = ":%d" % port
    for line in text.splitlines():
        if "LISTENING" not in line.upper():
            continue
        parts = line.split()
        if len(parts) < 5 or not parts[1].endswith(suffix):
            continue
        try:
            return int(parts[-1])
        except ValueError:
            return 0
    return 0


def request_shutdown(token: str) -> bool:
    if not token:
        return False
    try:
        request = urllib.request.Request(
            "http://127.0.0.1:%d/shutdown" % PORT,
            data=b"",
            method="POST",
            headers={"X-Kokoro-Token": token},
        )
        open_local(request, 5).read()
        return True
    except Exception:
        return False


def server_log_tail(tmp: str) -> str:
    for name in ("server.err", "server.log"):
        path = os.path.join(tmp, name)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                lines = [line.strip() for line in handle.read().splitlines() if line.strip()]
        except OSError:
            continue
        if lines:
            return lines[-1]
    return ""


def kill_verified(pid: int, root: str) -> bool:
    """只杀命令行确认是这个目录 server.py 的进程。对不上就不动。"""
    if not pid:
        return False
    for _ in range(3):
        if not pid_alive(pid):
            return False
        matched = any(
            item_pid == int(pid) and command_line_is_server(command, root)
            for item_pid, command in python_processes()
        )
        if matched:
            return _taskkill(pid) or _stop_process(pid)
        time.sleep(0.2)
    return False


def start_choice(root: str, existing, health_running: bool):
    """返回 (reuse|foreign|wait|spawn|unknown, listener)。"""
    listener = listening_pid(PORT) if health_running else 0
    if not health_running:
        return ("wait" if existing else "spawn", listener)
    kind = listener_kind(listener, root, existing)
    if kind == "ours":
        return ("reuse", listener)
    if kind == "foreign":
        return ("foreign", listener)
    if existing:
        return ("wait", listener)
    return ("unknown", listener)


def start_service(root: str, device: str, wait: bool = True, temp_dir: str = "", token: str = "") -> dict:
    existing = set(pids_for_server(root))
    health = service_state()
    decision, listener = start_choice(root, existing, health["running"])
    if decision == "foreign":
        for pid in list(existing):
            kill_verified(pid, root)
        fail("8765 端口上是另一份服务，没有启动新的。")
    if decision == "unknown":
        fail("8765 端口上已经有服务，但认不出是哪一份，没有再启动。")
    if decision == "reuse":
        return {"started": False, "running": True, "device": health["device"], "pid": listener}
    if decision == "wait":
        if not wait:
            return {"started": True, "running": False, "device": device, "pid": min(existing)}
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            health = service_state()
            decision, listener = start_choice(root, existing, health["running"])
            if decision == "reuse":
                return {"started": False, "running": True, "device": health["device"], "pid": listener}
            if decision == "foreign":
                for pid in list(existing):
                    kill_verified(pid, root)
                fail("8765 端口上是另一份服务，没有启动新的。")
            if not any(pid_alive(pid) for pid in existing):
                existing = set()
                break
            time.sleep(0.5)
        else:
            for pid in list(existing):
                kill_verified(pid, root)
            fail("本地 Kokoro 启动超时。请再点一次朗读。")
    if not token:
        fail("没有本地服务令牌，服务不会在没有令牌的情况下启动。")
    python = venv_python(root, device)
    if not python:
        fail("当前选择的运行环境未下载。")
    server = os.path.join(root, "server.py")
    if not os.path.isfile(server):
        fail("安装目录里没有 server.py，请重新安装。")
    tmp = os.path.join(root, "tmp")
    os.makedirs(tmp, exist_ok=True)
    # 服务每跑一次会在 TEMP 里攒一份 espeak-ng.dll 的副本。起服务前先把旧的清掉。
    cleanup_temp(tmp, 60)
    env = os.environ.copy()
    env["KOKORO_TOKEN"] = token
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
    keep = False
    try:
        if not wait:
            keep = True
            return {"started": True, "running": False, "device": device, "pid": process.pid}
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if process.poll() is not None:
                tail = server_log_tail(tmp)
                fail("本地 Kokoro 没有启动起来。" + (tail if tail else ""))
            health = service_state()
            decision, _listener = start_choice(root, set(pids_for_server(root)) | {process.pid}, health["running"])
            if decision == "reuse":
                keep = True
                return {"started": True, "running": True, "device": health["device"], "pid": process.pid}
            if decision == "foreign":
                fail("8765 端口上是另一份服务，没有启动新的。")
            time.sleep(0.5)
        fail("本地 Kokoro 启动超时。请再点一次朗读。")
    finally:
        if not keep and process.poll() is None:
            kill_verified(process.pid, root)


def stop_service(root: str, token: str = "") -> dict:
    """只停这个数据目录下的 server.py。

    关闭请求只发给命令行已经对上的那个监听进程。pid 文件里的数字也要先核对命令行，
    对不上就不杀。不再按 /health 报的目录，也不再用模糊匹配去扫别的 Python。
    """
    stopped = []
    ours = set(pids_for_server(root))
    pid_file = os.path.join(root, "kokoro.pid")
    file_pid = 0
    try:
        with open(pid_file, "r", encoding="utf-8") as handle:
            file_pid = int((handle.read() or "0").strip() or 0)
    except (OSError, ValueError):
        file_pid = 0
    if file_pid and pid_alive(file_pid):
        matched = any(pid == file_pid and command_line_is_server(command, root) for pid, command in python_processes())
        if matched:
            ours.add(file_pid)
    listener = listening_pid(PORT)
    if listener and listener in ours and request_shutdown(token):
        stopped.append("shutdown")
        time.sleep(0.5)
    for pid in sorted(ours):
        if not pid_alive(pid):
            continue
        if _taskkill(pid) or _stop_process(pid):
            stopped.append(str(pid))
    try:
        os.remove(pid_file)
    except OSError:
        pass
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
    emit(start_service(
        root, device, wait=wait, temp_dir=args.get("temp-dir") or "",
        token=load_token(args.get("token-file") or ""),
    ))


def cmd_stop(argv):
    args, rest = parse_args(argv)
    root = os.path.abspath(args.get("root") or ".")
    emit(stop_service(root, load_token(args.get("token-file") or "")))


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
        stop_service(root, load_token(args.get("token-file") or ""))
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
    token = load_token(args.get("token-file") or "")
    if not token:
        fail("没有本地服务令牌。")
    with open(text_file, "r", encoding="utf-8") as handle:
        text = handle.read().strip()
    state = service_state()
    if not state["running"]:
        state = start_service(root, device, wait=True, token=token)
    payload = json.dumps({"input": text, "voice": voice, "speed": float(speed)}).encode("utf-8")
    request = urllib.request.Request(
        "http://127.0.0.1:%d/v1/audio/speech" % PORT,
        data=payload,
        headers={"Content-Type": "application/json", "X-Kokoro-Token": token},
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
    "check-dir": cmd_check_dir,
    "cleanup": cmd_cleanup,
    "install": cmd_install,
    "sync": cmd_sync,
    "python-install": cmd_python_install,
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
