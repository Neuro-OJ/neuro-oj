"""验证独立 Judge 转发器在客户端退出后立即断开上游。"""

import importlib.util
import socket
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location("judge_proxy", Path(__file__).resolve().parents[1] / "deploy/judge-llm-proxy.py")
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
        server = proxy.create_server(("127.0.0.1", 0), f"http://127.0.0.1:{upstream.server_port}")
        for target in (upstream, server):
            threading.Thread(target=target.serve_forever, daemon=True).start()
        try:
            client = socket.create_connection(server.server_address)
            client.sendall(b"POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}")
            self.assertTrue(received.wait(2))
            client.close()
            self.assertTrue(disconnected.wait(2), "客户端退出后上游请求仍未关闭")
        finally:
            for target in (server, upstream):
                target.shutdown()
                target.server_close()


if __name__ == "__main__":
    unittest.main()
