import io
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf
import torch
from kokoro import KPipeline
from misaki.espeak import EspeakG2P

REPO_ID = "hexgrad/Kokoro-82M-v1.1-zh"
DEFAULT_VOICE = "zf_094"
PORT = int(os.environ.get("KOKORO_PORT", "8765"))

ROOT = os.path.dirname(__file__)
os.environ.setdefault("HF_HUB_CACHE", os.path.join(ROOT, "hf-cache"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
TMP = os.path.join(ROOT, "tmp")
os.makedirs(TMP, exist_ok=True)
os.environ["TEMP"] = TMP
os.environ["TMP"] = TMP


def build_pipeline():
    english = EspeakG2P("en-us")

    def en_callable(text):
        phonemes, _ = english(text)
        return phonemes

    return KPipeline(lang_code="z", repo_id=REPO_ID, device="cpu", en_callable=en_callable)


PIPELINE = build_pipeline()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?", 1)[0] != "/health":
            self.send_error(404)
            return
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/v1/audio/speech":
            self.send_error(404)
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
        try:
            chunks = []
            for _graphemes, _phonemes, audio in PIPELINE(text[:800], voice=voice, speed=speed):
                chunks.append(audio)
        except Exception as error:
            print(f"speech failed: {error}", flush=True)
            self.send_error(500, "voice failed")
            return
        if not chunks:
            self.send_error(500, "no audio")
            return
        wav = torch.cat(chunks).numpy()
        buffer = io.BytesIO()
        sf.write(buffer, wav, 24000, format="WAV")
        payload = buffer.getvalue()
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
