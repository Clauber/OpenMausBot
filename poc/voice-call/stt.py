import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel

cache = Path.home() / '.cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots'
model_path = next(cache.iterdir())
model = WhisperModel(str(model_path), device='cuda', compute_type='float16', local_files_only=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.respond(200, {'ok': True, 'model': 'faster-whisper-small', 'device': 'cuda'})

    def respond(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        if not 3200 <= length <= 960000 or length % 2:
            return self.respond(400, {'error': 'Expected 0.1 to 30 seconds of 16 kHz mono PCM16'})
        audio = np.frombuffer(self.rfile.read(length), dtype='<i2').astype(np.float32) / 32768
        started = time.perf_counter()
        try:
            segments, info = model.transcribe(audio, beam_size=1, vad_filter=True,
                                             condition_on_previous_text=False)
            text = ''.join(segment.text for segment in segments).strip()
            self.respond(200, {'text': text, 'language': info.language,
                               'ms': round((time.perf_counter() - started) * 1000)})
        except Exception as error:
            self.respond(500, {'error': str(error)})


server = HTTPServer(('127.0.0.1', 0), Handler)
print(json.dumps({'port': server.server_port, 'pid': os.getpid()}), flush=True)


def stop_on_disconnect():
    import sys
    sys.stdin.buffer.read()
    os._exit(0)


threading.Thread(target=stop_on_disconnect, daemon=True).start()
server.serve_forever()
