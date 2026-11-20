"""验证独立 Judge 转发器的断开传播、Keepalive、透传头与异常恢复能力。"""

import importlib.util
import json
import socket
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "judge_proxy",
    Path(__file__).resolve().parents[1] / "deploy/judge-llm-proxy.py",
)
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class ProxyTest(unittest.TestCase):
    def test_client_disconnect_propagates_to_upstream(self):
        received, disconnected = threading.Event(), threading.Event()

        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.connection.settimeout(3)
                received.set()
                if self.connection.recv(1) == b"":
                    disconnected.set()

            def log_message(self, *_args):
                pass

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        server = proxy.create_server(
            ("127.0.0.1", 0),
            f"http://127.0.0.1:{upstream.server_port}",
        )
        for target in (upstream, server):
            threading.Thread(target=target.serve_forever, daemon=True).start()
        try:
            client = socket.create_connection(server.server_address)
            client.sendall(
                b"POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}",
            )
            self.assertTrue(received.wait(2))
            client.close()
            self.assertTrue(disconnected.wait(2), "客户端退出后上游请求仍未关闭")
        finally:
            for target in (server, upstream):
                target.shutdown()
                target.server_close()

    def test_server_defaults_and_keepalive_enabled(self):
        self.assertGreaterEqual(proxy.ProxyHTTPServer.request_queue_size, 128)
        self.assertTrue(proxy.ProxyHTTPServer.daemon_threads)
        self.assertEqual(proxy.MAX_BODY_BYTES, 10 * 1024 * 1024)

        keepalive_seen = []

        class Upstream(BaseHTTPRequestHandler):
            def do_GET(self):
                body = b'{"status":"ok"}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("X-Noj-Call-Id", "call-123")
                self.send_header("Retry-After", "5")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        server = proxy.create_server(
            ("127.0.0.1", 0),
            f"http://127.0.0.1:{upstream.server_port}",
        )
        orig_get_request = proxy.ProxyHTTPServer.get_request

        def recording_get_request(self_srv):
            conn, addr = orig_get_request(self_srv)
            keepalive_seen.append(
                conn.getsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE),
            )
            return conn, addr

        for target in (upstream, server):
            threading.Thread(target=target.serve_forever, daemon=True).start()
        try:
            with patch.object(
                proxy.ProxyHTTPServer,
                "get_request",
                recording_get_request,
            ):
                req = urllib.request.Request(
                    f"http://127.0.0.1:{server.server_port}/health",
                    method="GET",
                )
                with urllib.request.urlopen(req, timeout=3) as resp:
                    self.assertEqual(resp.status, 200)
                    self.assertEqual(resp.headers.get("X-Noj-Call-Id"), "call-123")
                    self.assertEqual(resp.headers.get("Retry-After"), "5")
                    self.assertEqual(
                        json.loads(resp.read().decode("utf-8")),
                        {"status": "ok"},
                    )
            self.assertEqual(len(keepalive_seen), 1)
            self.assertNotEqual(keepalive_seen[0], 0)
        finally:
            for target in (server, upstream):
                target.shutdown()
                target.server_close()

    def test_upstream_remote_disconnect_returns_502(self):
        class DropUpstream(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.connection.close()

            def log_message(self, *_args):
                pass

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), DropUpstream)
        server = proxy.create_server(
            ("127.0.0.1", 0),
            f"http://127.0.0.1:{upstream.server_port}",
        )
        for target in (upstream, server):
            threading.Thread(target=target.serve_forever, daemon=True).start()
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                data=b"{}",
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(req, timeout=3)
            self.assertEqual(ctx.exception.code, 502)
            ctx.exception.close()
        finally:
            for target in (server, upstream):
                target.shutdown()
                target.server_close()

    def test_watch_client_ignores_transient_blocking_and_interrupted_errors(self):
        done = threading.Event()
        fake_sock = object()

        with patch.object(proxy.select, "select", side_effect=InterruptedError()):
            self.assertFalse(proxy._peek_client_closed(fake_sock, done))

        class BlockingSock:
            def recv(self, *_args):
                raise BlockingIOError()

        with patch.object(proxy.select, "select", return_value=([1], [], [])):
            self.assertFalse(proxy._peek_client_closed(BlockingSock(), done))

        class PipelinedSock:
            def recv(self, *_args):
                return b"x"

        with patch.object(proxy.select, "select", return_value=([1], [], [])):
            self.assertFalse(proxy._peek_client_closed(PipelinedSock(), done))

        class EofSock:
            def recv(self, *_args):
                return b""

        with patch.object(proxy.select, "select", return_value=([1], [], [])):
            self.assertTrue(proxy._peek_client_closed(EofSock(), done))


if __name__ == "__main__":
    unittest.main()
