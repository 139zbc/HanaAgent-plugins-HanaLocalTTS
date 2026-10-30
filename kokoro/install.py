"""分开下载模型、CPU 运行环境或 GPU 运行环境。

用法: python install.py --root <安装目录> --component <model|cpu|gpu> --source <modelscope|hf-mirror|huggingface>

模型放进 HF 缓存布局（hf-cache/models--hexgrad--Kokoro-82M-v1.1-zh/...）。
CPU 环境在 .venv-cpu，GPU 环境在 .venv-cuda。两套互不覆盖。

每一步把进度写进 install-state.json，App 轮询这个文件显示进度。
失败时 state 写成 failed，错误原因写进 message。
"""

import argparse
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

REPO_ID_HF = "hexgrad/Kokoro-82M-v1.1-zh"
REPO_ID_MS = "AI-ModelScope/Kokoro-82M-v1.1-zh"
CONFIG_FILE = "config.json"
MODEL_FILE = "kokoro-v1_1-zh.pth"
DEFAULT_VOICE = "zf_094"
VOICE_RE = re.compile(r"^[a-z]{2}_\d{3}$")
DEPENDENCIES = [
    "kokoro==0.9.4",
    "soundfile",
    "espeakng-loader",
    "phonemizer-fork",
    "ordered-set",
    "pypinyin",
    "pypinyin-dict",
    "cn2an",
    "jieba",
    "huggingface_hub",
    "modelscope",
]


CURRENT_COMPONENT = ""
STATE_DIR = None
# 一次安装里的进度只进不退（阶段与阶段之间也要接上）。
PROGRESS_HIGH = 0.0
# install.py 自己没有控制台（宿主里是隐藏窗口起的）。子进程如果也不带这个标志，
# Windows 会给它新开一个黑色控制台窗口——下载时弹窗就是这么来的。
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
NO_WINDOW = {"creationflags": CREATE_NO_WINDOW} if os.name == "nt" else {}


def write_state(root: Path, phase: str, message: str, percent: float | None = None, error: str | None = None):
    payload = {"phase": phase, "message": message}
    if percent is not None:
        payload["percent"] = round(percent, 1)
    if error:
        payload["error"] = error
    if CURRENT_COMPONENT:
        payload["component"] = CURRENT_COMPONENT
    text = json.dumps(payload, ensure_ascii=False)
    (root / "install-state.json").write_text(text, encoding="utf-8")
    # 镜像一份到 App 的数据目录：Node 那边读不到安装目录，只能读自己那份。
    if STATE_DIR:
        try:
            Path(STATE_DIR).mkdir(parents=True, exist_ok=True)
            (Path(STATE_DIR) / "install-state.json").write_text(text, encoding="utf-8")
        except OSError:
            pass


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 1800) -> subprocess.CompletedProcess:
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, **NO_WINDOW)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip().splitlines()
        raise RuntimeError("; ".join(tail[-3:]) if tail else f"命令失败: {cmd[0]}")
    return result


PERCENT_RE = re.compile(r"(?<!\d)(\d{1,3}(?:\.\d+)?)%")
RATIO_RE = re.compile(r"(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)")
PACKAGE_RE = re.compile(r"(?:Downloading|Collecting)\s+(\S+)")
# pip 命中本地缓存时直接跳过下载：「Using cached <url> (78 kB)」。这种包算已完成。
CACHED_RE = re.compile(r"^Using cached\s+(\S+)")
# pip 的 raw 进度条会打「Progress 123456 of 198400000」，就是实打实的字节数。
PROGRESS_RE = re.compile(r"Progress\s+(\d+)\s+of\s+(\d+)")
# pip 报包大小时用的单位：「Downloading xxx.whl (198.4 MB)」。拿它算真实进度。
SIZE_RE = re.compile(r"\((\d+(?:\.\d+)?)\s*(kB|MB|GB|B)\b")
SIZE_UNITS = {"B": 1, "kB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3}
# 模型那几个文件的总大小（权重 + config + 一个声音包）。
MODEL_TOTAL_BYTES = 327_247_856 + 3_228 + 523_331


def describe_line(line: str, fallback: str) -> str:
    """把 pip / 下载库的一行收成短中文，给进度条文案用。"""
    if "Installing collected" in line or line.startswith("Successfully installed"):
        return "正在写入已下载的包…"
    for prefix, label in (("Downloading ", "正在下载 "), ("Collecting ", "正在获取 ")):
        if prefix in line:
            token = line.split(prefix, 1)[1].split()[0]
            # 有些包给的是直链，截断后看不出是哪个包；取文件名那一段。
            if "://" in token:
                token = token.rsplit("/", 1)[-1] or token
            return label + token[:48]
    return fallback


def progress_in_line(line: str) -> tuple[str, float | None, int | None, int | None]:
    """从一行输出里读出「哪个包、到多少了、这个包多大、已经下了多少字节」。

    pip 每下一个包，进度都会从 0 重新开始，所以只看单包的百分比会误以为
    整体在倒退。这里把包名和比率一起交出去，由调用方按包统计。
    """
    name = ""
    ratio = None
    size = None
    done = None
    if CACHED_RE.match(line):
        # 缓存里的包：没有下载这回事，别把里面的数字当进度。
        return name, ratio, size, done
    matched = PACKAGE_RE.search(line)
    if matched:
        name = matched.group(1)
        # 这一行只报包名和大小。直链里带数字和斜杠，不能当比率用。
        found = SIZE_RE.search(line)
        if found:
            size = int(float(found.group(1)) * SIZE_UNITS.get(found.group(2), 1))
    else:
        raw = PROGRESS_RE.search(line)
        if raw:
            done = int(raw.group(1))
            total = int(raw.group(2))
            if total > 0:
                ratio = max(0.0, min(1.0, done / total))
                size = total
        else:
            percent_match = PERCENT_RE.search(line)
            if percent_match:
                ratio = max(0.0, min(1.0, float(percent_match.group(1)) / 100))
            else:
                ratio_match = RATIO_RE.search(line)
                if ratio_match:
                    done_value = float(ratio_match.group(1))
                    total = float(ratio_match.group(2))
                    if total > 0:
                        ratio = max(0.0, min(1.0, done_value / total))
    return name, ratio, size, done


def phase_fraction(packages: dict[str, float], current: float = 0.0) -> float:
    """把各个包的进度合成为整个阶段的进度。

    pip 的包是边下边发现的，不知道一共几个，所以按「已下完的包 + 当前这个包的
    比率」除以「已下完的包数 + 1」来估：每下完一个包，进度就往上走一截，
    当前包在下的部分填满剩下的区间。全程只增不减。
    """
    done = 0
    active = current
    for ratio in packages.values():
        if ratio >= 0.999:
            done += 1
        elif ratio > active:
            active = ratio
    return min(0.99, (done + active) / (done + 1))


def dir_bytes(path: Path) -> int:
    """一个目录里所有文件的字节数。量下载进度用。"""
    total = 0
    stack = [str(path)]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        else:
                            total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def fmt_bytes(value: float) -> str:
    """字节数写成人能看的样子：1.2 MB。"""
    value = float(value)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return ("%.0f %s" % (value, unit)) if unit == "B" else ("%.1f %s" % (value, unit))
        value /= 1024
    return "%.1f GB" % value


def pip_watcher(root: Path) -> Callable[[], int]:
    """量 pip 已经下了多少字节。

    pip 把下载中的包放在 TEMP 下的 pip-unpack-* 目录里。run_live 会把子进程的
    TEMP 指到安装目录的 tmp 下，所以这里直接量那几个目录就行。
    """

    def measure() -> int:
        total = 0
        try:
            entries = list((root / "tmp").glob("pip-unpack-*"))
        except OSError:
            return 0
        for entry in entries:
            total += dir_bytes(entry)
        return total

    return measure


def run_live(
    root: Path,
    cmd: list[str],
    phase: str,
    message: str,
    floor: float,
    ceil: float,
    timeout: int = 1800,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    watch: Callable[[], int] | None = None,
    watch_install: Callable[[], int] | None = None,
    total_bytes: int = 0,
    stall_seconds: int = 0,
) -> None:
    """跑长时间命令，边读输出边更新进度。没有百分比时，进度也会慢慢往前走，避免看起来卡死。

    watch：量磁盘上已下载字节数的函数。给了它就能报真进度（pip 在管道里不吐百分比）。
    watch_install：量“已写入”了多少字节的函数。pip 把包解包写进 venv 时一声不吭，
        只能看目录长大了多少。
    total_bytes：整个阶段一共有多少字节。给了它就按字节算整个阶段的进度。
    stall_seconds：多久没字节变化算卡住。卡住就杀掉进程报错，让上层重试。
    """
    global PROGRESS_HIGH
    # 阶段之间的进度也要接上：上一阶段到了 40%，下一阶段不能从 15% 重新开始。
    floor = max(floor, PROGRESS_HIGH)
    write_state(root, phase, message, floor)
    merged = os.environ.copy()
    merged["PYTHONUNBUFFERED"] = "1"
    # pip 的 rich 进度条在管道里不渲染中间帧，什么都看不到；raw 模式会老实打
    # 「Progress 12345 of 198400000」，那才是真进度。
    merged["PIP_PROGRESS_BAR"] = "raw"
    # 子进程的临时目录放在安装目录里，方便事后查残留，也方便量下载进度。
    merged["TEMP"] = str(root / "tmp")
    merged["TMP"] = str(root / "tmp")
    if env:
        merged.update(env)
    proc = subprocess.Popen(
        cmd, cwd=cwd, env=merged,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        **NO_WINDOW,
    )
    lines: queue.Queue[bytes | None] = queue.Queue()

    def read_output() -> None:
        assert proc.stdout is not None
        while True:
            # read(256) 要凑满 256 字节才返回，一批输出里的百分比会被同时写进状态文件，
            # 最后一个（下一个包刚开头的小百分比）就把进度条拉回去了。read1 有多少读多少。
            reader = getattr(proc.stdout, "read1", proc.stdout.read)
            chunk = reader(4096)
            if not chunk:
                lines.put(None)
                return
            lines.put(chunk)

    threading.Thread(target=read_output, daemon=True).start()
    started = time.monotonic()
    shown = floor
    detail = message
    last_write = 0.0
    last_text = message
    last_real = 0.0
    pending = b""
    tail: list[str] = []
    packages: dict[str, float] = {}
    # 当前正在下的包：名字、总共多少字节、开始时已经下了多少。
    current_name = ""
    current_size = 0
    current_base = 0
    current_done: int | None = None
    installing = False
    installed_bytes = 0
    watched = 0
    prev_watched = 0
    prev_at = time.monotonic()
    speed = 0.0
    last_byte_at = time.monotonic()
    last_measure = 0.0
    last_measure_install = 0.0
    downloading = False

    def speed_note() -> str:
        """进度文案后面挂一句：下了多少、多快、多久没动。

        不用实时刷新，但一眼能看出是不是网络卡住了。
        """
        if total_bytes:
            bits = ["%s / %s" % (fmt_bytes(watched), fmt_bytes(total_bytes))]
            if speed > 1024:
                bits.append("%s/s" % fmt_bytes(speed))
            idle = time.monotonic() - last_byte_at
            if idle > 5:
                bits.append("%d 秒没有新进度" % int(idle))
            return "（%s）" % " · ".join(bits)
        if downloading and current_size:
            # pip 自己报的这个包已下多少字节最准，没有就拿磁盘上的差值。
            got = current_done if current_done is not None else max(0, watched - current_base)
            bits = ["%s / %s" % (fmt_bytes(got), fmt_bytes(current_size))]
            if speed > 1024:
                bits.append("%s/s" % fmt_bytes(speed))
            idle = time.monotonic() - last_byte_at
            if idle > 5:
                bits.append("%d 秒没有新进度" % int(idle))
            return "（%s）" % " · ".join(bits)
        if installing and watch_install is not None:
            # 正在把包解包写进环境：pip 一声不吭，就看目录长了多少。
            return "（已写入 %s · 已用 %d 分钟）" % (fmt_bytes(installed_bytes), int((time.monotonic() - started) // 60))
        return ""

    def publish(percent: float, text: str, force: bool = False) -> None:
        nonlocal shown, last_write, last_text
        now = time.monotonic()
        composed = text + speed_note()
        # 只进不退：pip 每下一个包都会从 0% 重新开始，直接用会让进度条往回跳。
        percent = max(shown, min(ceil, max(floor, percent)))
        if now - last_write < 0.6 and abs(percent - shown) < 2 and composed == last_text:
            return
        if not force and now - last_write < 1 and abs(percent - shown) < 0.8 and composed == last_text:
            return
        shown = percent
        last_write = now
        last_text = composed
        write_state(root, phase, composed, percent)

    def log_line(text: str) -> None:
        """子进程的原话落进 install.log，以后能查它到底干了什么。"""
        try:
            sys.stderr.write(text + "\n")
            sys.stderr.flush()
        except OSError:
            pass

    def take_line(raw: bytes) -> None:
        nonlocal detail, last_real, current_name, current_size, current_base, current_done, downloading, installing
        text = raw.decode("utf-8", "replace").strip()
        if not text:
            return
        tail.append(text)
        del tail[:-8]
        log_line(text)
        detail = describe_line(text, detail)
        if "Installing collected" in text or text.startswith("Successfully installed"):
            downloading = False
            installing = True
        cached = CACHED_RE.match(text)
        if cached:
            # 缓存里的包：不用下载，直接算已完成。
            packages[cached.group(1)] = 1.0
            last_real = time.monotonic()
            if not total_bytes:
                publish(floor + (ceil - floor) * phase_fraction(packages), detail, force=True)
            return
        name, ratio, size, done = progress_in_line(text)
        if name:
            # 新包开始下载：记住是哪个包，算进度用。
            downloading = True
            if name != current_name:
                current_name = name
                current_size = size or 0
                current_base = watched
                current_done = None
            elif size:
                current_size = size
        else:
            if size:
                # 「Progress 12345 of 198400000」：当前包的总大小和已下字节。
                current_size = size
            if done is not None:
                current_done = done
        if ratio is not None:
            key = current_name or name or "pkg"
            packages[key] = max(packages.get(key, 0.0), ratio)
            last_real = time.monotonic()
            if not total_bytes:
                # 已知总字节时只听字节的，不跟下载库自己报的百分比混着来。
                publish(floor + (ceil - floor) * phase_fraction(packages), detail, force=True)
        elif name:
            last_real = time.monotonic()
            publish(shown, detail)
        else:
            publish(shown, detail)

    while True:
        now = time.monotonic()
        # 量字节要每次循环都看一眼：pip 每 0.25 秒就吐一行，只在“闲下来”时量就永远量不到。
        if watch is not None and now - last_measure >= 1:
            last_measure = now
            try:
                size_now = watch()
            except OSError:
                size_now = watched
            if size_now != watched:
                # 有新字节：算一下这一秒下了多少。
                if prev_watched:
                    instant = (size_now - prev_watched) / max(0.001, now - prev_at)
                    speed = instant if speed <= 0 else (speed * 0.6 + instant * 0.4)
                prev_watched = size_now
                prev_at = now
                last_byte_at = now
                watched = size_now
                if total_bytes:
                    ratio = max(0.0, min(0.98, size_now / total_bytes))
                    publish(floor + (ceil - floor) * ratio, detail)
                elif current_size:
                    ratio = max(0.0, min(0.98, (size_now - current_base) / current_size))
                    publish(floor + (ceil - floor) * phase_fraction(packages, ratio), detail)
            else:
                if now - last_byte_at > 2:
                    speed = 0.0
                if stall_seconds and (downloading or total_bytes) and now - last_byte_at > stall_seconds:
                    # 多久没有一个字节进来：真的卡住了。杀掉重试，别让用户干等。
                    proc.kill()
                    raise RuntimeError(
                        "下载卡住了：%d 秒没有新进度（当前在 %s）" % (stall_seconds, current_name or "下载")
                    )
        # 解包写盘阶段：pip 不出声，只能看环境目录长了多少。
        if watch_install is not None and now - last_measure_install >= 2:
            last_measure_install = now
            try:
                written = watch_install()
            except OSError:
                written = installed_bytes
            if written != installed_bytes:
                installed_bytes = written
                publish(shown, detail)
        if time.monotonic() - started > timeout:
            proc.kill()
            raise RuntimeError("超时")
        try:
            item = lines.get(timeout=1)
        except queue.Empty:
            idle = time.monotonic() - max(last_real, started)
            if idle >= 2:
                span = max(0.0, ceil - floor - 4)
                creep = floor + span * (1 - pow(2.718, -(time.monotonic() - started) / 80))
                publish(max(shown, creep), detail)
            if proc.poll() is not None:
                break
            continue
        if item is None:
            break
        pending += item
        parts = re.split(br"[\r\n]", pending)
        pending = parts[-1]
        for part in parts[:-1]:
            take_line(part)
        if pending:
            text = pending.decode("utf-8", "replace").strip()
            name, ratio, size, done = progress_in_line(text)
            if name:
                downloading = True
                if name != current_name:
                    current_name = name
                    current_size = size or 0
                    current_base = watched
                    current_done = None
                elif size:
                    current_size = size
                detail = describe_line(text, detail)
                last_real = time.monotonic()
                publish(shown, detail)
            elif ratio is not None:
                key = current_name or name or "pkg"
                packages[key] = max(packages.get(key, 0.0), ratio)
                last_real = time.monotonic()
                detail = describe_line(text, detail)
                if size:
                    current_size = size
                if done is not None:
                    current_done = done
                if not total_bytes:
                    publish(floor + (ceil - floor) * phase_fraction(packages), detail, force=True)
            elif size or done is not None:
                if size:
                    current_size = size
                if done is not None:
                    current_done = done
                publish(shown, detail)
            else:
                publish(shown, detail)
    if pending:
        take_line(pending)
    code = proc.wait(timeout=30)
    if code != 0:
        raise RuntimeError("; ".join(tail[-3:]) if tail else f"命令失败: {cmd[0]}")
    PROGRESS_HIGH = max(PROGRESS_HIGH, ceil)


def hf_cache_layout(root: Path) -> tuple[Path, Path]:
    """返回 (hf-cache 目录, 快照目录)。布局和 huggingface_hub 的缓存一致。"""
    cache = root / "hf-cache" / f"models--{REPO_ID_HF.replace('/', '--')}"
    snapshot = cache / "snapshots" / "installed"
    return cache, snapshot


def create_venv(root: Path, base_python: str, folder: str) -> tuple[Path, Path]:
    write_state(root, "venv", "正在创建 Python 环境…", 5)
    venv_dir = root / folder
    python = venv_dir / "Scripts" / "python.exe"
    if not python.exists():
        run([base_python, "-m", "venv", str(venv_dir)])
    return venv_dir, python


def model_file(root: Path) -> Path:
    _, snapshot = hf_cache_layout(root)
    return snapshot / MODEL_FILE


def mark_runtime(venv_dir: Path, device: str) -> None:
    (venv_dir / "runtime.json").write_text(
        json.dumps({"device": device}, ensure_ascii=False), encoding="utf-8"
    )


def can_import_download_libs(python: Path) -> bool:
    result = subprocess.run(
        [str(python), "-c", "import modelscope, huggingface_hub"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
        **NO_WINDOW,
    )
    return result.returncode == 0


def python_for_download(root: Path, base_python: str, pip_source: str) -> Path:
    """模型下载不进 CPU / GPU 运行环境。有现成环境就借用，没有就建一个只装下载库的小环境。"""
    for folder in (".venv-cpu", ".venv-cuda", ".venv"):
        python = root / folder / "Scripts" / "python.exe"
        if python.exists() and can_import_download_libs(python):
            return python
    write_state(root, "venv", "正在准备模型下载环境…", 5)
    _, python = create_venv(root, base_python, ".venv-download")
    run_pip(
        root,
        [str(python), "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location",
         "modelscope", "huggingface_hub", "--index-url", PIP_INDEXES[pip_source]],
        "deps", "正在准备模型下载工具…", 8, 40, timeout=1800,
    )
    return python


PIP_INDEXES = {
    "tuna": "https://pypi.tuna.tsinghua.edu.cn/simple",
    "aliyun": "https://mirrors.aliyun.com/pypi/simple",
    "pypi": "https://pypi.org/simple",
}
TORCH_INDEXES = {
    "pytorch": "https://download.pytorch.org/whl/cu130",
    "nju": "https://mirror.nju.edu.cn/pytorch/whl/cu130",
}


def env_without_proxy() -> dict[str, str]:
    """只给这一次子进程用。不改用户机器上的代理设置。"""
    env = os.environ.copy()
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        env.pop(key, None)
    env["NO_PROXY"] = "*"
    env["no_proxy"] = "*"
    return env


def run_pip(
    root: Path,
    cmd: list[str],
    phase: str,
    message: str,
    floor: float,
    ceil: float,
    timeout: int,
    watch: Callable[[], int] | None = None,
    watch_install: Callable[[], int] | None = None,
    stall_seconds: int = 0,
) -> None:
    """先按当前环境下载。失败后再用同一个源、不走代理试一次。不会自行换成别的源。"""
    try:
        run_live(root, cmd, phase, message, floor, ceil, timeout=timeout, watch=watch,
                 watch_install=watch_install, stall_seconds=stall_seconds)
        return
    except RuntimeError as first:
        write_state(root, phase, "上一次没下成，正在不走代理再试同一个源…", floor)
        try:
            run_live(root, cmd, phase, message, floor, ceil, timeout=timeout, env=env_without_proxy(),
                     watch=watch, watch_install=watch_install, stall_seconds=stall_seconds)
        except RuntimeError as second:
            raise RuntimeError(f"先前：{first}；不走代理再试仍失败：{second}") from second


def install_cuda_torch(root: Path, python: Path, torch_source: str, pip_source: str) -> None:
    write_state(root, "torch", "正在下载 GPU 版 PyTorch（约 2GB）…", 30)
    cmd = [
        str(python), "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location",
        "torch==2.14.1+cu130",
        "--index-url", TORCH_INDEXES[torch_source],
        "--extra-index-url", PIP_INDEXES[pip_source],
    ]
    run_pip(root, cmd, "torch", "正在下载 GPU 版 PyTorch（约 2GB）…", 30, 88, timeout=7200)


def install_dependencies(root: Path, vpython: Path, pip_source: str, floor: float, ceil: float) -> None:
    cmd = [
        str(vpython), "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location",
        "--timeout", "30", "--retries", "3",
        *DEPENDENCIES, "--index-url", PIP_INDEXES[pip_source],
    ]
    # pip 在管道里不吐百分比，只能靠看临时目录里多了多少字节。卡住两分钟就当它死了。
    # 解包写盘那一步 pip 一声不吭，就看环境目录长了多少字节。
    venv_dir = vpython.parent.parent
    run_pip(root, cmd, "deps", "正在安装依赖（含 PyTorch，体积较大）…", floor, ceil, timeout=7200,
            watch=pip_watcher(root), watch_install=lambda: dir_bytes(venv_dir), stall_seconds=120)


def snapshot_files(voice: str) -> tuple[str, ...]:
    """模型安装要取的文件：config、权重，以及当前选中的那一个声音。

    声音文件按需补下（换声音时由助手单独下那一个），所以这里只带默认的那一个。
    """
    return (CONFIG_FILE, MODEL_FILE, f"voices/{voice}.pt")


def place_snapshot(root: Path, source_dir: Path, voice: str) -> None:
    """把下载好的文件摆进 HF 缓存布局。只摆模型必备的那几个文件。"""
    _, snapshot = hf_cache_layout(root)
    snapshot.mkdir(parents=True, exist_ok=True)
    (snapshot / "voices").mkdir(exist_ok=True)
    for rel in snapshot_files(voice):
        src = source_dir / rel
        if not src.exists():
            raise RuntimeError(f"下载缺少文件: {rel}")
        dst = snapshot / rel
        if dst.exists():
            dst.unlink()
        shutil.copy2(src, dst)
    (root / "hf-cache" / f"models--{REPO_ID_HF.replace('/', '--')}" / "refs").mkdir(parents=True, exist_ok=True)
    (root / "hf-cache" / f"models--{REPO_ID_HF.replace('/', '--')}" / "refs" / "main").write_text("installed", encoding="utf-8")


def download_modelscope(root: Path, vpython: Path, voice: str) -> None:
    """只取模型权重、config 和选中的那一个声音，不下整个仓库的 100 多个声音。

    allow_patterns 是较新版本才有的参数：探测不到就退回全量下载（保正确性）。
    """
    local_dir = root / "ms-download"
    shutil.rmtree(local_dir, ignore_errors=True)
    patterns = repr(list(snapshot_files(voice)))
    script = (
        "import inspect\n"
        "from modelscope import snapshot_download\n"
        f"local_dir = r'{local_dir}'\n"
        f"patterns = {patterns}\n"
        "params = inspect.signature(snapshot_download).parameters\n"
        "if 'allow_patterns' in params:\n"
        f"    snapshot_download({REPO_ID_MS!r}, local_dir=local_dir, allow_patterns=patterns)\n"
        "else:\n"
        f"    snapshot_download({REPO_ID_MS!r}, local_dir=local_dir)\n"
    )
    run_live(
        root, [str(vpython), "-c", script], "model", "正在从 ModelScope 下载模型（约 328MB）…", 40, 88, timeout=3600, cwd=root,
        watch=lambda: dir_bytes(local_dir), total_bytes=MODEL_TOTAL_BYTES, stall_seconds=120,
    )
    place_snapshot(root, local_dir, voice)
    shutil.rmtree(local_dir, ignore_errors=True)


def download_hf(root: Path, vpython: Path, mirror: bool, voice: str) -> None:
    env = {**os.environ, "HF_HUB_CACHE": str(root / "hf-cache"), "TEMP": str(root / "tmp"), "TMP": str(root / "tmp")}
    if mirror:
        env["HF_ENDPOINT"] = "https://hf-mirror.com"
    label = "HF 镜像" if mirror else "HuggingFace"
    cache, _ = hf_cache_layout(root)
    patterns = repr(list(snapshot_files(voice)))
    script = (
        "import inspect\n"
        "from huggingface_hub import snapshot_download\n"
        f"cache = r'{root / 'hf-cache'}'\n"
        f"patterns = {patterns}\n"
        "params = inspect.signature(snapshot_download).parameters\n"
        "if 'allow_patterns' in params:\n"
        f"    snapshot_download({REPO_ID_HF!r}, cache_dir=cache, allow_patterns=patterns)\n"
        "else:\n"
        f"    snapshot_download({REPO_ID_HF!r}, cache_dir=cache)\n"
    )
    run_live(
        root, [str(vpython), "-c", script], "model", f"正在从 {label} 下载模型（约 328MB）…",
        40, 88, timeout=3600, cwd=root, env=env,
        watch=lambda: dir_bytes(cache / "blobs"), total_bytes=MODEL_TOTAL_BYTES, stall_seconds=120,
    )
    # HF 下载的快照名是 commit hash；找到它并重命名为 installed，
    # 与 ModelScope 来源保持同一布局，refs/main 都指向 installed
    target = cache / "snapshots" / "installed"
    # installed 里没有权重（上次只摆了一半）就先清掉，改用这次下好的，避免残缺快照挡住。
    if target.is_dir() and not (target / MODEL_FILE).is_file():
        shutil.rmtree(target, ignore_errors=True)
    if not target.is_dir():
        snaps_dir = cache / "snapshots"
        snaps = [p for p in snaps_dir.iterdir() if p.is_dir() and p.name != "installed"] if snaps_dir.is_dir() else []
        if not snaps:
            raise RuntimeError("下载结果里没有找到模型文件")
        snaps[0].rename(target)
    (cache / "refs").mkdir(parents=True, exist_ok=True)
    (cache / "refs" / "main").write_text("installed", encoding="utf-8")


def verify(root: Path, vpython: Path, device: str) -> None:
    write_state(root, "verify", "正在验证模型能不能加载…", 90)
    script = (
        "import os; os.environ['HF_HUB_OFFLINE']='1';"
        "from kokoro import KPipeline;"
        "from misaki.espeak import EspeakG2P;"
        f"p = KPipeline(lang_code='z', repo_id={REPO_ID_HF!r}, device={device!r}, en_callable=lambda t: EspeakG2P('en-us')(t)[0]);"
        "print('ok')"
    )
    env = {**os.environ, "HF_HUB_CACHE": str(root / "hf-cache"), "TEMP": str(root / "tmp"), "TMP": str(root / "tmp")}
    result = subprocess.run([str(vpython), "-c", script], cwd=str(root), env=env,
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600, **NO_WINDOW)
    if result.returncode != 0 or "ok" not in (result.stdout or ""):
        tail = (result.stderr or "").strip().splitlines()
        raise RuntimeError("验证失败: " + ("; ".join(tail[-3:]) if tail else "没有输出"))


def install_model(root: Path, base_python: str, source: str, pip_source: str, voice: str) -> None:
    # 权重已在本地就不再下一遍：老用户升级、或者重复点「下载」，都从这里直接返回。
    if model_file(root).exists():
        write_state(root, "done", "模型已下载", 100)
        return
    python = python_for_download(root, base_python, pip_source)
    if source == "modelscope":
        download_modelscope(root, python, voice)
    else:
        download_hf(root, python, mirror=source == "hf-mirror", voice=voice)
    if not model_file(root).exists():
        raise RuntimeError("下载结束但没有找到模型文件")
    write_state(root, "done", "模型已下载", 100)


def install_runtime(root: Path, base_python: str, device: str, pip_source: str, torch_source: str) -> None:
    folder = ".venv-cuda" if device == "cuda" else ".venv-cpu"
    venv_dir, python = create_venv(root, base_python, folder)
    # CPU 的 torch 是 kokoro 的依赖，跟着一起下；GPU 的 torch 单独下一份 cu130 版。
    # 两段的百分比首尾相接，进度条才不会往回跳。
    if device == "cuda":
        install_dependencies(root, python, pip_source, 8, 30)
    else:
        install_dependencies(root, python, pip_source, 8, 88)
    if device == "cuda":
        install_cuda_torch(root, python, torch_source, pip_source)
    if model_file(root).exists():
        verify(root, python, device)
    else:
        write_state(root, "verify", "运行环境已装好。模型还是未下载，跳过加载验证。", 90)
    mark_runtime(venv_dir, device)
    label = "GPU" if device == "cuda" else "CPU"
    write_state(root, "done", f"{label} 运行环境已下载", 100)


def main() -> None:
    global CURRENT_COMPONENT, STATE_DIR
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--source", default="modelscope")
    parser.add_argument("--pip-source", default="tuna")
    parser.add_argument("--torch-source", default="nju")
    parser.add_argument("--component", choices=["model", "cpu", "gpu"], required=True)
    parser.add_argument("--state-dir", default="")
    # 模型安装时带上当前选中的声音，只下那一个声音文件。
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    args = parser.parse_args()
    CURRENT_COMPONENT = args.component
    STATE_DIR = args.state_dir or None

    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    (root / "tmp").mkdir(exist_ok=True)
    try:
        # server.py 由 App 发起安装时复制进来
        if not (root / "server.py").exists():
            raise RuntimeError("缺少 server.py，请从 App 重新发起安装")
        pip_source = args.pip_source if args.pip_source in PIP_INDEXES else ""
        torch_source = args.torch_source if args.torch_source in TORCH_INDEXES else ""
        if args.component == "model":
            if args.source not in ("modelscope", "hf-mirror", "huggingface"):
                raise RuntimeError("不认识的模型下载源")
            if pip_source not in PIP_INDEXES:
                pip_source = "tuna"
            voice = args.voice if VOICE_RE.match(args.voice or "") else DEFAULT_VOICE
            install_model(root, sys.executable, args.source, pip_source, voice)
        elif args.component == "cpu":
            if args.source in PIP_INDEXES:
                pip_source = args.source
            if pip_source not in PIP_INDEXES:
                raise RuntimeError("不认识的 CPU 依赖下载源")
            install_runtime(root, sys.executable, "cpu", pip_source, "pytorch")
        else:
            if args.source in TORCH_INDEXES:
                torch_source = args.source
            if pip_source not in PIP_INDEXES:
                raise RuntimeError("不认识的 CPU 依赖下载源")
            if torch_source not in TORCH_INDEXES:
                raise RuntimeError("不认识的 GPU 依赖下载源")
            install_runtime(root, sys.executable, "cuda", pip_source, torch_source)
    except Exception as error:  # noqa: BLE001 - 失败原因要写给 UI
        write_state(root, "failed", f"安装失败：{error}", None, str(error))
        raise


if __name__ == "__main__":
    main()
