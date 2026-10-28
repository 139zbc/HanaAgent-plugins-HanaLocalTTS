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
from pathlib import Path

REPO_ID_HF = "hexgrad/Kokoro-82M-v1.1-zh"
REPO_ID_MS = "AI-ModelScope/Kokoro-82M-v1.1-zh"
MODEL_FILE = "kokoro-v1_1-zh.pth"
SNAPSHOT_FILES = ("config.json", MODEL_FILE, "voices/zf_094.pt")
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


def write_state(root: Path, phase: str, message: str, percent: float | None = None, error: str | None = None):
    payload = {"phase": phase, "message": message}
    if percent is not None:
        payload["percent"] = round(percent, 1)
    if error:
        payload["error"] = error
    if CURRENT_COMPONENT:
        payload["component"] = CURRENT_COMPONENT
    (root / "install-state.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 1800) -> subprocess.CompletedProcess:
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip().splitlines()
        raise RuntimeError("; ".join(tail[-3:]) if tail else f"命令失败: {cmd[0]}")
    return result


PERCENT_RE = re.compile(r"(?<!\d)(\d{1,3}(?:\.\d+)?)%")
RATIO_RE = re.compile(r"(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)")


def describe_line(line: str, fallback: str) -> str:
    """把 pip / 下载库的一行收成短中文，给进度条文案用。"""
    if "Installing collected" in line or line.startswith("Successfully installed"):
        return "正在写入已下载的包…"
    for prefix, label in (("Downloading ", "正在下载 "), ("Collecting ", "正在获取 ")):
        if prefix in line:
            name = line.split(prefix, 1)[1].split()[0][:48]
            return label + name
    return fallback


def percent_in_line(line: str, floor: float, ceil: float) -> float | None:
    matched = PERCENT_RE.search(line)
    if matched:
        return floor + (ceil - floor) * max(0.0, min(1.0, float(matched.group(1)) / 100))
    matched = RATIO_RE.search(line)
    if matched:
        done = float(matched.group(1))
        total = float(matched.group(2))
        if total > 0:
            return floor + (ceil - floor) * max(0.0, min(1.0, done / total))
    return None


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
) -> None:
    """跑长时间命令，边读输出边更新进度。没有百分比时，进度也会慢慢往前走，避免看起来卡死。"""
    write_state(root, phase, message, floor)
    merged = os.environ.copy()
    merged["PYTHONUNBUFFERED"] = "1"
    merged["PIP_PROGRESS_BAR"] = "on"
    if env:
        merged.update(env)
    proc = subprocess.Popen(
        cmd, cwd=cwd, env=merged,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    lines: queue.Queue[bytes | None] = queue.Queue()

    def read_output() -> None:
        assert proc.stdout is not None
        while True:
            chunk = proc.stdout.read(256)
            if not chunk:
                lines.put(None)
                return
            lines.put(chunk)

    threading.Thread(target=read_output, daemon=True).start()
    started = time.monotonic()
    shown = floor
    detail = message
    last_write = 0.0
    last_real = 0.0
    pending = b""
    tail: list[str] = []

    def publish(percent: float, text: str, force: bool = False) -> None:
        nonlocal shown, last_write
        now = time.monotonic()
        percent = max(floor, min(ceil, percent))
        if now - last_write < 0.6 and abs(percent - shown) < 2 and text == detail:
            return
        if not force and now - last_write < 1 and abs(percent - shown) < 0.8:
            return
        shown = percent
        last_write = now
        write_state(root, phase, text, percent)

    def take_line(raw: bytes) -> None:
        nonlocal detail, last_real
        text = raw.decode("utf-8", "replace").strip()
        if not text:
            return
        tail.append(text)
        del tail[:-8]
        found = percent_in_line(text, floor, ceil)
        detail = describe_line(text, detail)
        if found is not None:
            last_real = time.monotonic()
            publish(found, detail, force=True)
        else:
            publish(shown, detail)

    while True:
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
            found = percent_in_line(text, floor, ceil)
            if found is not None:
                last_real = time.monotonic()
                detail = describe_line(text, detail)
                publish(found, detail, force=True)
    if pending:
        take_line(pending)
    code = proc.wait(timeout=30)
    if code != 0:
        raise RuntimeError("; ".join(tail[-3:]) if tail else f"命令失败: {cmd[0]}")


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


def run_pip(root: Path, cmd: list[str], phase: str, message: str, floor: float, ceil: float, timeout: int) -> None:
    """先按当前环境下载。失败后再用同一个源、不走代理试一次。不会自行换成别的源。"""
    try:
        run_live(root, cmd, phase, message, floor, ceil, timeout=timeout)
        return
    except RuntimeError as first:
        write_state(root, phase, "上一次没下成，正在不走代理再试同一个源…", floor)
        try:
            run_live(root, cmd, phase, message, floor, ceil, timeout=timeout, env=env_without_proxy())
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
    run_pip(root, cmd, "torch", "正在下载 GPU 版 PyTorch（约 2GB）…", 32, 88, timeout=7200)


def install_dependencies(root: Path, vpython: Path, pip_source: str) -> None:
    cmd = [
        str(vpython), "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location",
        *DEPENDENCIES, "--index-url", PIP_INDEXES[pip_source],
    ]
    run_pip(root, cmd, "deps", "正在安装依赖（含 PyTorch，体积较大）…", 8, 78, timeout=7200)


def place_snapshot(root: Path, source_dir: Path) -> None:
    """把下载好的文件摆进 HF 缓存布局。"""
    _, snapshot = hf_cache_layout(root)
    snapshot.mkdir(parents=True, exist_ok=True)
    (snapshot / "voices").mkdir(exist_ok=True)
    for rel in SNAPSHOT_FILES:
        src = source_dir / rel
        if not src.exists():
            raise RuntimeError(f"下载缺少文件: {rel}")
        dst = snapshot / rel
        if dst.exists():
            dst.unlink()
        shutil.copy2(src, dst)
    (root / "hf-cache" / f"models--{REPO_ID_HF.replace('/', '--')}" / "refs").mkdir(parents=True, exist_ok=True)
    (root / "hf-cache" / f"models--{REPO_ID_HF.replace('/', '--')}" / "refs" / "main").write_text("installed", encoding="utf-8")


def download_modelscope(root: Path, vpython: Path) -> None:
    script = (
        "from modelscope import snapshot_download;"
        f"snapshot_download({REPO_ID_MS!r}, local_dir=r'{root / 'ms-download'}')"
    )
    run_live(root, [str(vpython), "-c", script], "model", "正在从 ModelScope 下载模型（约 313MB）…", 15, 88, timeout=3600, cwd=root)
    place_snapshot(root, root / "ms-download")
    shutil.rmtree(root / "ms-download", ignore_errors=True)


def download_hf(root: Path, vpython: Path, mirror: bool) -> None:
    env = {**os.environ, "HF_HUB_CACHE": str(root / "hf-cache"), "TEMP": str(root / "tmp"), "TMP": str(root / "tmp")}
    if mirror:
        env["HF_ENDPOINT"] = "https://hf-mirror.com"
    label = "HF 镜像" if mirror else "HuggingFace"
    script = f"from huggingface_hub import snapshot_download; snapshot_download({REPO_ID_HF!r}, cache_dir=r'{root / 'hf-cache'}')"
    run_live(
        root, [str(vpython), "-c", script], "model", f"正在从 {label} 下载模型（约 313MB）…",
        15, 88, timeout=3600, cwd=root, env=env,
    )
    # HF 下载的快照名是 commit hash；找到它并重命名为 installed，
    # 与 ModelScope 来源保持同一布局，refs/main 都指向 installed
    cache, _ = hf_cache_layout(root)
    snaps = [p for p in (cache / "snapshots").iterdir() if p.is_dir()]
    if not snaps:
        raise RuntimeError("下载结果里没有找到模型文件")
    target = cache / "snapshots" / "installed"
    if target.exists():
        shutil.rmtree(target)
    snaps[0].rename(target)
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
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
    if result.returncode != 0 or "ok" not in (result.stdout or ""):
        tail = (result.stderr or "").strip().splitlines()
        raise RuntimeError("验证失败: " + ("; ".join(tail[-3:]) if tail else "没有输出"))


def install_model(root: Path, base_python: str, source: str, pip_source: str) -> None:
    python = python_for_download(root, base_python, pip_source)
    if source == "modelscope":
        download_modelscope(root, python)
    else:
        download_hf(root, python, mirror=source == "hf-mirror")
    if not model_file(root).exists():
        raise RuntimeError("下载结束但没有找到模型文件")
    write_state(root, "done", "模型已具备", 100)


def install_runtime(root: Path, base_python: str, device: str, pip_source: str, torch_source: str) -> None:
    folder = ".venv-cuda" if device == "cuda" else ".venv-cpu"
    venv_dir, python = create_venv(root, base_python, folder)
    install_dependencies(root, python, pip_source)
    if device == "cuda":
        install_cuda_torch(root, python, torch_source, pip_source)
    if model_file(root).exists():
        verify(root, python, device)
    else:
        write_state(root, "verify", "运行环境已装好。模型还是未下载，跳过加载验证。", 90)
    mark_runtime(venv_dir, device)
    label = "GPU" if device == "cuda" else "CPU"
    write_state(root, "done", f"{label} 运行环境已具备", 100)


def main() -> None:
    global CURRENT_COMPONENT
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--source", default="modelscope")
    parser.add_argument("--pip-source", default="tuna")
    parser.add_argument("--torch-source", default="nju")
    parser.add_argument("--component", choices=["model", "cpu", "gpu"], required=True)
    args = parser.parse_args()
    CURRENT_COMPONENT = args.component

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
            install_model(root, sys.executable, args.source, pip_source)
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
