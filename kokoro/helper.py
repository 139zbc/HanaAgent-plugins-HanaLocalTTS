"""Kokoro 助手的命令行入口。

App 进程受 Node 权限模型限制：只能读安装目录和自己的 app-data，读不到用户选的
安装目录，也不能自己连本机端口。所以碰盘、碰端口的活都交给这个助手做，Node 只负责
调度和解析结果。

约定：每次调用只往 stdout 写一行 JSON，出错写 stderr 并以非零码退出。
"""

import json
import os
import sys
import urllib.request

PORT = int(os.environ.get("KOKORO_PORT", "8765"))
MODEL_DIR = "models--hexgrad--Kokoro-82M-v1.1-zh"
MODEL_FILE = "kokoro-v1_1-zh.pth"
ACTIVE_PHASES = ("venv", "deps", "torch", "model", "verify")


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
        "foreign": foreign,
    })


COMMANDS = {
    "probe": cmd_probe,
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
