"""一键安装本地 Kokoro。

用法: python install.py --root <安装目录> --source <modelscope|hf-mirror|huggingface>

在安装目录里建 Python 虚拟环境、装依赖、按所选来源下载模型。
模型统一放进 HF 缓存布局（hf-cache/models--hexgrad--Kokoro-82M-v1.1-zh/...），
这样 server.py 里 KPipeline(repo_id=...) 三个来源读到的都是同一种结构。

每一步把进度写进 install-state.json，App 轮询这个文件显示进度。
失败时 state 写成 failed，错误原因写进 message。
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
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


def write_state(root: Path, phase: str, message: str, percent: float | None = None, error: str | None = None):
    payload = {"phase": phase, "message": message}
    if percent is not None:
        payload["percent"] = round(percent, 1)
    if error:
        payload["error"] = error
    (root / "install-state.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 1800) -> subprocess.CompletedProcess:
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip().splitlines()
        raise RuntimeError("; ".join(tail[-3:]) if tail else f"命令失败: {cmd[0]}")
    return result


def hf_cache_layout(root: Path) -> tuple[Path, Path]:
    """返回 (hf-cache 目录, 快照目录)。布局和 huggingface_hub 的缓存一致。"""
    cache = root / "hf-cache" / f"models--{REPO_ID_HF.replace('/', '--')}"
    snapshot = cache / "snapshots" / "installed"
    return cache, snapshot


def create_venv(root: Path, base_python: str) -> Path:
    write_state(root, "venv", "正在创建 Python 环境…", 2)
    venv_dir = root / ".venv"
    if not (venv_dir / "Scripts" / "python.exe").exists():
        run([base_python, "-m", "venv", str(venv_dir)])
    return venv_dir / "Scripts" / "python.exe"


def install_dependencies(root: Path, vpython: Path) -> None:
    write_state(root, "deps", "正在安装依赖（含 torch，约 1GB，需要几分钟）…", 5)
    run([str(vpython), "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", *DEPENDENCIES])


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
    write_state(root, "model", "正在从 ModelScope 下载模型（约 313MB）…", 15)
    script = (
        "from modelscope import snapshot_download;"
        f"snapshot_download({REPO_ID_MS!r}, local_dir=r'{root / 'ms-download'}')"
    )
    run([str(vpython), "-c", script], cwd=str(root), timeout=3600)
    place_snapshot(root, root / "ms-download")
    shutil.rmtree(root / "ms-download", ignore_errors=True)


def download_hf(root: Path, vpython: Path, mirror: bool) -> None:
    env = {**os.environ, "HF_HUB_CACHE": str(root / "hf-cache"), "TEMP": str(root / "tmp"), "TMP": str(root / "tmp")}
    if mirror:
        env["HF_ENDPOINT"] = "https://hf-mirror.com"
    label = "HF 镜像" if mirror else "HuggingFace"
    write_state(root, "model", f"正在从 {label} 下载模型（约 313MB）…", 15)
    script = f"from huggingface_hub import snapshot_download; snapshot_download({REPO_ID_HF!r}, cache_dir=r'{root / 'hf-cache'}')"
    result = subprocess.run([str(vpython), "-c", script], cwd=str(root), env=env,
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=3600)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip().splitlines()
        raise RuntimeError("; ".join(tail[-3:]) if tail else "下载失败")
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


def verify(root: Path, vpython: Path) -> None:
    write_state(root, "verify", "正在验证模型能不能加载…", 90)
    script = (
        "import os; os.environ['HF_HUB_OFFLINE']='1';"
        "from kokoro import KPipeline;"
        "from misaki.espeak import EspeakG2P;"
        f"p = KPipeline(lang_code='z', repo_id={REPO_ID_HF!r}, device='cpu', en_callable=lambda t: EspeakG2P('en-us')(t)[0]);"
        "print('ok')"
    )
    env = {**os.environ, "HF_HUB_CACHE": str(root / "hf-cache"), "TEMP": str(root / "tmp"), "TMP": str(root / "tmp")}
    result = subprocess.run([str(vpython), "-c", script], cwd=str(root), env=env,
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
    if result.returncode != 0 or "ok" not in (result.stdout or ""):
        tail = (result.stderr or "").strip().splitlines()
        raise RuntimeError("验证失败: " + ("; ".join(tail[-3:]) if tail else "没有输出"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--source", choices=["modelscope", "hf-mirror", "huggingface"], default="modelscope")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    (root / "tmp").mkdir(exist_ok=True)
    try:
        # server.py 由 App 发起安装时复制进来
        if not (root / "server.py").exists():
            raise RuntimeError("缺少 server.py，请从 App 重新发起安装")
        vpython = create_venv(root, sys.executable)
        install_dependencies(root, vpython)
        if args.source == "modelscope":
            download_modelscope(root, vpython)
        else:
            download_hf(root, vpython, mirror=args.source == "hf-mirror")
        verify(root, vpython)
        write_state(root, "done", "安装完成", 100)
    except Exception as error:  # noqa: BLE001 - 失败原因要写给 UI
        write_state(root, "failed", f"安装失败：{error}", None, str(error))
        raise


if __name__ == "__main__":
    main()
