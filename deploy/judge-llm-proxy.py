"""独立 Judge 网络的固定目标 LLM 转发器；客户端退出时关闭上游连接。"""

import http.client
import os
import select
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


class Handler(BaseHTTPRequestHandler):
    def forward(self):
        if self.path not in ("/health", "/v1/chat/completions"):
            self.send_error(404)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400)
            return
        if not 0 <= size <= 1024 * 1024:
            self.send_error(413)
            return
        body = self.rfile.read(size)
        upstream = self.server.upstream
        connection = http.client.HTTPConnection(upstream.hostname, upstream.port or 80, timeout=270)
        done = threading.Event()
        disconnected = threading.Event()

        def watch_client():
            while not done.is_set():
                try:
                    ready, _, _ = select.select([self.connection], [], [], 0.1)
                    closed = bool(ready) and not self.connection.recv(1, socket.MSG_PEEK)
                except OSError:
                    closed = True
                if closed:
                    disconnected.set()
                    # shutdown 能唤醒另一线程阻塞的 getresponse/read；只调用 close 不足以唤醒。
                    if connection.sock:
                        try:
                            connection.sock.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                    return

        watcher = None
        try:
            connection.connect()
            watcher = threading.Thread(target=watch_client, daemon=True)
            watcher.start()
            headers = {key: self.headers[key] for key in ("Authorization", "Content-Type") if key in self.headers}
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            data = response.read()
            if disconnected.is_set():
                return
            self.send_response(response.status)
            for key in ("Content-Type", "Retry-After"):
                value = response.getheader(key)
                if value is not None:
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (OSError, http.client.HTTPException):
            if not disconnected.is_set():
                try:
                    self.send_error(502, "LLM gateway unavailable")
                except OSError:
                    pass
        finally:
            done.set()
            if watcher:
                watcher.join(timeout=0.5)
            connection.close()

    do_GET = forward
    do_POST = forward

    def log_message(self, format, *args):
        # 不记录认证头、请求正文或凭据。
        print(format % args, flush=True)


def create_server(address, upstream):
    """构造固定目标转发器，供部署与本地断开测试共用。"""
    parsed = urlsplit(upstream)
    if parsed.scheme != "http" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("JUDGE_GATEWAY_UPSTREAM 必须是可信内网 HTTP 地址")
    server = ThreadingHTTPServer(address, Handler)
    server.upstream = parsed
    return server


if __name__ == "__main__":
    create_server(("0.0.0.0", 8001), os.environ["JUDGE_GATEWAY_UPSTREAM"]).serve_forever()
