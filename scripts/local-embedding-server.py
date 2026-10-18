#!/usr/bin/env python3
"""Local OpenAI-compatible embedding server for evaluation.

This is an optional development tool, not part of the zero-dependency core.
It requires `sentence-transformers` and a local model; it lets the offline test
suite run against real embeddings without a paid provider.

Usage:
    HF_ENDPOINT=https://hf-mirror.com \
    python scripts/local-embedding-server.py

Then point the eval at it:
    DREAM_EMBEDDING_API_KEY=local \
    DREAM_EMBEDDING_BASE_URL=http://127.0.0.1:19527/v1 \
    DREAM_EMBEDDING_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 \
    pnpm experiments
"""

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from sentence_transformers import SentenceTransformer

MODEL_NAME = os.environ.get(
    "LOCAL_EMBED_MODEL",
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
)
PORT = int(os.environ.get("LOCAL_EMBED_PORT", "19527"))
MODEL = SentenceTransformer(MODEL_NAME)
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # silence per-request logs
        pass

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/v1/models":
            self._send(200, {"object": "list", "data": [{"id": MODEL_NAME, "object": "model"}]})
        else:
            self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/embeddings":
            self._send(404, {"error": {"message": "not found"}})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            raw = body.get("input", [])
            texts = [raw] if isinstance(raw, str) else list(raw)
            with LOCK:
                vectors = MODEL.encode(texts, normalize_embeddings=True)
            data = [
                {"object": "embedding", "index": i, "embedding": [float(x) for x in vector]}
                for i, vector in enumerate(vectors)
            ]
            self._send(
                200,
                {
                    "object": "list",
                    "model": MODEL_NAME,
                    "data": data,
                    "usage": {"prompt_tokens": sum(len(t) for t in texts), "total_tokens": sum(len(t) for t in texts)},
                },
            )
        except Exception as exc:  # pragma: no cover - dev server
            self._send(500, {"error": {"message": str(exc)}})


if __name__ == "__main__":
    print(f"embedding server: {MODEL_NAME} on http://127.0.0.1:{PORT}/v1", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
