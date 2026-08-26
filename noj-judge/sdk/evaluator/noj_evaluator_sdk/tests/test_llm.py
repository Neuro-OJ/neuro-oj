"""
noj_evaluator_sdk.llm 单元测试。
"""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import TestCase

from noj_evaluator_sdk import llm


class _Handler(BaseHTTPRequestHandler):
    status = 200
    response = {"ok": True, "usage": {"total_tokens": 10}}
    received = None

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        _Handler.received = json.loads(self.rfile.read(length))
        body = json.dumps(_Handler.response).encode("utf-8")
        self.send_response(_Handler.status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def _start_server():
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class LlmTest(TestCase):
    def setUp(self):
        self._old_env = {}
        for key in (
            "NOJ_LLM_GATEWAY_URL",
            "NOJ_LLM_TOKEN",
            "NOJ_LLM_PROVIDER_ID",
            "NOJ_LLM_ALLOWED_MODELS",
        ):
            self._old_env[key] = os.environ.get(key)
            os.environ.pop(key, None)

    def tearDown(self):
        for key, value in self._old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_missing_env_raises(self):
        with self.assertRaises(llm.LLMError):
            llm.complete(model="qwen-plus", messages=[{"role": "user", "content": "hi"}])

    def test_complete_success(self):
        server = _start_server()
        try:
            os.environ["NOJ_LLM_GATEWAY_URL"] = f"http://127.0.0.1:{server.server_port}"
            os.environ["NOJ_LLM_TOKEN"] = "test-token"
            os.environ["NOJ_LLM_ALLOWED_MODELS"] = "qwen-plus,qwen-max"
            result = llm.complete(
                model="qwen-plus",
                messages=[{"role": "user", "content": "hello"}],
                temperature=0,
            )
            self.assertTrue(result["ok"])
            self.assertEqual(_Handler.received["model"], "qwen-plus")
            self.assertEqual(_Handler.received["temperature"], 0)
        finally:
            server.shutdown()
            server.server_close()

    def test_upstream_error_raises(self):
        server = _start_server()
        old_status = _Handler.status
        _Handler.status = 500
        _Handler.response = {"error": "boom"}
        try:
            os.environ["NOJ_LLM_GATEWAY_URL"] = f"http://127.0.0.1:{server.server_port}"
            os.environ["NOJ_LLM_TOKEN"] = "test-token"
            os.environ["NOJ_LLM_ALLOWED_MODELS"] = "qwen-plus"
            with self.assertRaises(llm.LLMError):
                llm.complete(model="qwen-plus", messages=[{"role": "user", "content": "hi"}])
        finally:
            _Handler.status = old_status
            server.shutdown()
            server.server_close()
