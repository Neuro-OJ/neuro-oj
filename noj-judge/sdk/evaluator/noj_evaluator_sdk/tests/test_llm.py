"""
noj_evaluator_sdk.llm 单元测试。
"""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import TestCase
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from io import BytesIO

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

    def test_out_of_usage_error_raises_structured(self):
        server = _start_server()
        old_status = _Handler.status
        old_response = _Handler.response
        _Handler.status = 429
        _Handler.response = {"error": {"code": "out_of_usage"}}
        try:
            os.environ["NOJ_LLM_GATEWAY_URL"] = f"http://127.0.0.1:{server.server_port}"
            os.environ["NOJ_LLM_TOKEN"] = "test-token"
            os.environ["NOJ_LLM_ALLOWED_MODELS"] = "qwen-plus"
            with self.assertRaises(llm.LLMError) as ctx:
                llm.complete(model="qwen-plus", messages=[{"role": "user", "content": "hi"}])
            self.assertEqual(ctx.exception.status_code, 429)
            self.assertEqual(ctx.exception.error_code, "out_of_usage")
        finally:
            _Handler.status = old_status
            _Handler.response = old_response
            server.shutdown()
            server.server_close()

    def _mock_response(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"choices": [{"message": {"content": "OK"}}]}'
        return response

    def test_transient_500_retries_once_and_recovers(self):
        os.environ["NOJ_LLM_GATEWAY_URL"] = "http://gateway"
        os.environ["NOJ_LLM_TOKEN"] = "test-token"
        failure = HTTPError("http://gateway", 500, "upstream", {}, BytesIO(b'{"error":"upstream_error"}'))
        with patch("urllib.request.urlopen", side_effect=[failure, self._mock_response()]) as request, patch("time.sleep"):
            response = llm.complete(model="model", messages=[{"role":"user","content":"hi"}], timeout=185)
            self.assertEqual(response["choices"][0]["message"]["content"], "OK")
            self.assertEqual(request.call_count, 2)
            self.assertNotIn("timeout", json.loads(request.call_args.args[0].data))
            self.assertNotIn("max_retries", json.loads(request.call_args.args[0].data))

    def test_out_of_usage_is_not_retried(self):
        os.environ["NOJ_LLM_GATEWAY_URL"] = "http://gateway"
        os.environ["NOJ_LLM_TOKEN"] = "test-token"
        failure = HTTPError("http://gateway", 429, "quota", {}, BytesIO(b'{"error":{"code":"out_of_usage"}}'))
        with patch("urllib.request.urlopen", side_effect=failure) as request, patch("time.sleep") as sleep:
            with self.assertRaises(llm.LLMError) as error:
                llm.complete(model="model", messages=[{"role":"user","content":"hi"}])
            self.assertEqual(error.exception.error_code, "out_of_usage")
            self.assertEqual(request.call_count, 1)
            sleep.assert_not_called()

    def test_retries_are_bounded_on_connection_failure(self):
        os.environ["NOJ_LLM_GATEWAY_URL"] = "http://gateway"
        os.environ["NOJ_LLM_TOKEN"] = "test-token"
        with patch("urllib.request.urlopen", side_effect=TimeoutError("timeout")) as request, patch("time.sleep"):
            with self.assertRaises(llm.LLMError):
                llm.complete(model="model", messages=[{"role":"user","content":"hi"}])
            self.assertEqual(request.call_count, 2)

    def test_rate_limit_waits_for_retry_after_then_recovers(self):
        os.environ["NOJ_LLM_GATEWAY_URL"] = "http://gateway"
        os.environ["NOJ_LLM_TOKEN"] = "test-token"
        failure = HTTPError("http://gateway", 429, "rate", {"Retry-After":"60"}, BytesIO(b'{"error":{"code":"rate_limit_exceeded"}}'))
        with patch("urllib.request.urlopen", side_effect=[failure, self._mock_response()]) as request, patch("time.sleep") as sleep:
            llm.complete(model="model", messages=[{"role":"user","content":"hi"}])
            sleep.assert_called_once_with(60.0)
            self.assertEqual(request.call_count, 2)
