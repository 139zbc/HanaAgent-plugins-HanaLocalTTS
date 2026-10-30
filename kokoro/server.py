import hmac
import io
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
_MODEL = os.path.join(
    ROOT, "hf-cache", "models--hexgrad--Kokoro-82M-v1.1-zh", "snapshots", "installed", "kokoro-v1_1-zh.pth",
)
if os.path.isfile(_MODEL):
    os.environ["HF_HUB_OFFLINE"] = "1"
os.environ.setdefault("HF_HUB_CACHE", os.path.join(ROOT, "hf-cache"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import soundfile as sf
import torch
from kokoro import KPipeline
from misaki.espeak import EspeakG2P

REPO_ID = "hexgrad/Kokoro-82M-v1.1-zh"
DEFAULT_VOICE = "zf_094"
PORT = int(os.environ.get("KOKORO_PORT", "8765"))
DEVICE = "cuda" if os.environ.get("KOKORO_DEVICE", "cpu") == "cuda" and torch.cuda.is_available() else "cpu"
TMP = os.path.join(ROOT, "tmp")
os.makedirs(TMP, exist_ok=True)
os.environ["TEMP"] = TMP
os.environ["TMP"] = TMP


def write_pid_file():
    """把自己的 pid 写下来：停止时按它杀进程树。

    得在加载模型之前写——加载模型要几十秒，那段时间里服务已经占着端口了。
    """
    try:
        with open(os.path.join(ROOT, "kokoro.pid"), "w", encoding="utf-8") as handle:
            handle.write(str(os.getpid()))
    except OSError:
        pass


write_pid_file()


def build_pipeline():
    english = EspeakG2P("en-us")

    def en_callable(text):
        phonemes, _ = english(text)
        return phonemes

    return KPipeline(lang_code="z", repo_id=REPO_ID, device=DEVICE, en_callable=en_callable)


PIPELINE = build_pipeline()
# 同一时刻只跑一路推理。锁住整段合成，不包括后面把音频写出去。
INFERENCE_LOCK = threading.Lock()


def token_ok(header_value):
    """启动时由助手放进环境变量。没带对令牌就不能关服务，也不能合成。"""
    expected = os.environ.get("KOKORO_TOKEN") or ""
    got = header_value or ""
    if not expected or not got:
        return False
    return hmac.compare_digest(expected, got)


class Handler(BaseHTTPRequestHandler):
    def authorized(self):
        return token_ok(self.headers.get("X-Kokoro-Token"))

    def do_GET(self):
        if self.path.split("?", 1)[0] != "/health":
            self.send_error(404)
            return
        body = json.dumps({"ok": True, "device": DEVICE, "root": ROOT}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/shutdown":
            if not self.authorized():
                self.send_error(401, "unauthorized")
                return
            # 自己退出：助手先请服务退，退不动再按核对过的 pid 杀进程树。
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")
            threading.Thread(target=server.shutdown, daemon=True).start()
            return
        if path != "/v1/audio/speech":
            self.send_error(404)
            return
        if not self.authorized():
            self.send_error(401, "unauthorized")
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 200_000:
            self.send_error(400, "bad body")
            return
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            self.send_error(400, "not json")
            return
        text = str(data.get("input") or "").strip()
        if not text:
            self.send_error(400, "empty input")
            return
        if len(text) > 2000:
            self.send_error(400, "text too long")
            return
        voice = str(data.get("voice") or DEFAULT_VOICE)
        if not voice.replace("_", "").isalnum():
            self.send_error(400, "bad voice")
            return
        try:
            speed = float(data.get("speed") or 1)
        except (TypeError, ValueError):
            speed = 1
        speed = min(2, max(0.5, speed))
        print(f"speech voice={voice} speed={speed} chars={len(text)}", flush=True)
        payload = b""
        try:
            with INFERENCE_LOCK:
                chunks = []
                for _graphemes, _phonemes, audio in PIPELINE(text, voice=voice, speed=speed):
                    chunks.append(audio)
                if not chunks:
                    payload = b""
                else:
                    wav = torch.cat(chunks).numpy()
                    buffer = io.BytesIO()
                    sf.write(buffer, wav, 24000, format="WAV")
                    payload = buffer.getvalue()
        except Exception as error:
            print(f"speech failed: {error}", flush=True)
            self.send_error(500, "voice failed")
            return
        if not payload:
            self.send_error(500, "no audio")
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"ready {PORT}", flush=True)
    server.serve_forever()
