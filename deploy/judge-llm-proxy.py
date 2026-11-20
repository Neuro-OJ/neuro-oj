"""独立 Judge 网络的固定目标 LLM 转发器；客户端退出时关闭上游连接。"""

import http.client
import os
import select
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

MAX_BODY_BYTES = 10 * 1024 * 1024


def enable_tcp_keepalive(sock, idle=30, interval=10, count=3):
    """开启 TCP Keepalive 与 TCP_NODELAY，防止长排队/长推理期间被中间设备静默掐断。"""
    if sock is None:
        return
    for level, optname, value in (
        (socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1),
        (socket.IPPROTO_TCP, socket.TCP_NODELAY, 1),
    ):
        try:
            sock.setsockopt(level, optname, value)
        except OSError:
            pass
    for attr in ("TCP_KEEPIDLE", "TCP_KEEPALIVE"):
        opt = getattr(socket, attr, None)
        if opt is not None:
            try:
                sock.setsockopt(socket.IPPROTO_TCP, opt, idle)
            except OSError:
                pass
    for attr, val in (("TCP_KEEPINTVL", interval), ("TCP_KEEPCNT", count)):
        opt = getattr(socket, attr, None)
        if opt is not None:
            try:
                sock.setsockopt(socket.IPPROTO_TCP, opt, val)
            except OSError:
                pass


def _peek_client_closed(sock, done):
    """检查客户端 socket 是否已断开；瞬时中断或未读数据不误判为断连。"""
    try:
        ready, _, _ = select.select([sock], [], [], 0.1)
    except (BlockingIOError, InterruptedError):
        done.wait(0.05)
        return False
    except OSError:
        return True
    if not ready:
        return False
    try:
        peeked = sock.recv(1, socket.MSG_PEEK)
    except (BlockingIOError, InterruptedError):
        done.wait(0.05)
        return False
    except OSError:
        return True
    if peeked:
        # 仍有未消费字节而非 EOF，退避等待避免忙轮询。
        done.wait(0.1)
        return False
    return True


class ProxyHTTPServer(ThreadingHTTPServer):
    """并发转发服务器：扩大监听队列并启用接入 socket 的 TCP Keepalive。"""

    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 128

    def get_request(self):
        conn, addr = super().get_request()
        enable_tcp_keepalive(conn)
        return conn, addr


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
        if not 0 <= size <= MAX_BODY_BYTES:
            self.send_error(413)
            return
        body = self.rfile.read(size)
        upstream = self.server.upstream
        connection = http.client.HTTPConnection(
            upstream.hostname,
            upstream.port or 80,
            timeout=270,
        )
        done = threading.Event()
        disconnected = threading.Event()

        def watch_client():
            while not done.is_set():
                if _peek_client_closed(self.connection, done):
                    disconnected.set()
                    # shutdown 能唤醒另一线程阻塞的 getresponse/read；只调用 close 不足以唤醒。
                    sock = connection.sock
                    if sock is not None:
                        try:
                            sock.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                    return

        watcher = None
        try:
            connection.connect()
            enable_tcp_keepalive(connection.sock)
            watcher = threading.Thread(target=watch_client, daemon=True)
            watcher.start()
            headers = {
                key: self.headers[key]
                for key in ("Authorization", "Content-Type")
                if key in self.headers
            }
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            data = response.read()
            if disconnected.is_set():
                return
            self.send_response(response.status)
            for key in ("Content-Type", "Retry-After", "X-Noj-Call-Id"):
                value = response.getheader(key)
                if value is not None:
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (OSError, http.client.HTTPException) as exc:
            if not disconnected.is_set():
                self.log_message(
                    "upstream error %s %s: %s",
                    self.command,
                    self.path,
                    type(exc).__name__,
                )
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
    server = ProxyHTTPServer(address, Handler)
    server.upstream = parsed
    return server


if __name__ == "__main__":
    create_server(("0.0.0.0", 8001), os.environ["JUDGE_GATEWAY_UPSTREAM"]).serve_forever()
