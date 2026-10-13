"""E2E 专用 OpenAI 兼容上游；仅保留请求路径和实际模型用于调用归属验收。"""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit


class LlmMockServer(HTTPServer):
    def __init__(self, address):
        super().__init__(address, LlmMockHandler)
        self.requests = []


class LlmMockHandler(BaseHTTPRequestHandler):
    def reply(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlsplit(self.path).path == "/":
            self.reply(200, {"ok": True, "requests": self.server.requests})
        else:
            self.reply(200, {"ok": True})

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        model = payload.get("model")
        if not isinstance(model, str):
            self.reply(400, {"error": "model must be a string"})
            return
        self.server.requests.append({"path": urlsplit(self.path).path, "model": model})
        self.reply(200, {
            "ok": True,
            "model": model,
            "choices": [],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
        })

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    LlmMockServer(("0.0.0.0", 8002)).serve_forever()
