#!/usr/bin/env python3
"""E2E 显式同步屏障协调服务（Python 标准库，无第三方依赖）。

Browser E2E 需要「evaluator 已到达、但还没有调用真实 LLM」这一个确定状态：
等待方（evaluator 内的 evaluate.py）在 /gates/<id>/wait 上阻塞，测试进程看到
到达计数后经 Web UI 修改模型别名，再 /release 放行。这样用显式屏障替代固定
time.sleep(20)，既不再白等 20 秒，也不受机器快慢影响。

并发模型：ThreadingHTTPServer + 单个 threading.Condition 守护全部 gate 状态。
单线程 HTTPServer 会让阻塞中的 wait 独占进程，release 永远排不到队，所以必须
多线程。条件变量统一 notify_all，等待方被唤醒后各自复查自己的 gate 状态。

接口（契约由 scripts/e2e/check_test_coordinator.py 复核）：

- POST /gates：创建 run 所属的关闭状态 gate；请求体 {"id": ..., "run_id": ...}，
  重复 ID 返回 409
- GET /gates/<id>：返回到达数量、释放状态、取消状态
- GET /gates/<id>/wait?arrival=<nonce>&timeout=<秒>：记录到达并阻塞到释放/取消/超时
- POST /gates/<id>/release：幂等释放（后续 wait 立即通过，直到 DELETE）
- DELETE /gates/<id>：唤醒全部等待者并清理 gate
- GET /health：健康检查

部署约束：只把本服务接入专用 evaluator 网络（noj-eval-net），管理端口由 compose
绑定在宿主 loopback；写进 evaluator 的地址必须是容器网络内地址。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional
from urllib.parse import parse_qs, urlsplit

# 等待上限必须短于 evaluator 的 60 秒总时限，给真实 LLM 调用与收尾留出余量。
DEFAULT_WAIT_TIMEOUT = 45.0
# 允许调用方把单次等待缩短，但不得放大到 evaluator 时限之外。
MAX_WAIT_TIMEOUT = 120.0
MAX_BODY_BYTES = 64 * 1024
GATE_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
ARRIVAL_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")


class GateNotFound(Exception):
    """gate 不存在（或已被 DELETE 清理）。"""


class GateExists(Exception):
    """gate ID 已被占用；同一 run 内不允许静默复用。"""


class Gate:
    """单个屏障：去重到达集合、释放与取消状态。"""

    __slots__ = (
        "id",
        "run_id",
        "created_at",
        "arrivals",
        "released",
        "cancelled",
        "waiting",
    )

    def __init__(self, gate_id: str, run_id: str) -> None:
        self.id = gate_id
        self.run_id = run_id
        self.created_at = time.monotonic()
        self.arrivals: list[str] = []
        self.released = False
        self.cancelled = False
        # 当前阻塞在 wait 上的请求数，仅用于状态排查。
        self.waiting = 0

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "run_id": self.run_id,
            "arrivals": len(self.arrivals),
            "released": self.released,
            "cancelled": self.cancelled,
            "waiting": self.waiting,
        }


class CoordinatorState:
    """线程安全的 gate 注册表；所有状态变更都在同一条件变量下广播。"""

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._gates: dict[str, Gate] = {}

    def create(self, gate_id: str, run_id: str) -> dict[str, Any]:
        with self._condition:
            if gate_id in self._gates:
                raise GateExists(gate_id)
            gate = Gate(gate_id, run_id)
            self._gates[gate_id] = gate
            return gate.snapshot()

    def get(self, gate_id: str) -> dict[str, Any]:
        with self._condition:
            gate = self._gates.get(gate_id)
            if gate is None:
                raise GateNotFound(gate_id)
            return gate.snapshot()

    def count(self) -> int:
        with self._condition:
            return len(self._gates)

    def wait(self, gate_id: str, arrival: str, timeout: float) -> dict[str, Any]:
        """记录一次到达并阻塞到释放/取消/超时。

        相同 nonce 视为同一次到达（重连、重试都不重复计数），但仍要等到释放。
        """
        deadline = time.monotonic() + timeout
        with self._condition:
            gate = self._gates.get(gate_id)
            if gate is None:
                raise GateNotFound(gate_id)
            if arrival not in gate.arrivals:
                gate.arrivals.append(arrival)
            gate.waiting += 1
            try:
                while not gate.released and not gate.cancelled:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    self._condition.wait(remaining)
                snapshot = gate.snapshot()
            finally:
                gate.waiting -= 1
            timed_out = not snapshot["released"] and not snapshot["cancelled"]
            return {**snapshot, "arrival": arrival, "timed_out": timed_out}

    def release(self, gate_id: str) -> dict[str, Any]:
        with self._condition:
            gate = self._gates.get(gate_id)
            if gate is None:
                raise GateNotFound(gate_id)
            # 幂等：重复释放保持已释放状态并再次广播，后到的 wait 立即通过。
            gate.released = True
            self._condition.notify_all()
            return gate.snapshot()

    def cancel(self, gate_id: str) -> dict[str, Any]:
        with self._condition:
            gate = self._gates.pop(gate_id, None)
            if gate is None:
                raise GateNotFound(gate_id)
            gate.cancelled = True
            self._condition.notify_all()
            return {"id": gate_id, "cancelled": True}


class CoordinatorServer(ThreadingHTTPServer):
    """多线程 HTTP 服务；等待请求必须能与释放请求并行执行。"""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        state: Optional[CoordinatorState] = None,
    ):
        super().__init__(address, CoordinatorHandler)
        self.state = state or CoordinatorState()


class CoordinatorHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "NojTestCoordinator/1"

    # ── 日志：只记录方法、脱敏路径与状态码 ──────────────────────────────
    # 默认实现会把完整 self.path（含 ?arrival=<nonce>）写进日志；屏障 nonce 与
    # 请求体都可能是测试标识，因此统一降级为无 query 的路径，不记录 header/body。
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return

    def log_request(self, code: Any = "-", size: Any = "-") -> None:
        method = getattr(self, "command", None) or "-"
        raw_path = getattr(self, "path", "") or "/"
        path = urlsplit(raw_path).path or "/"
        sys.stderr.write(f"[coordinator] {method} {path} {code}\n")
        sys.stderr.flush()

    # ── 响应 ────────────────────────────────────────────────────────────
    def _reply(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            # 每个请求一条连接：等待请求会长时间占用线程，不能留 keep-alive。
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # 等待方主动取消（AbortSignal）会先断开连接，属正常路径。
            self.close_connection = True

    def _fail(self, status: int, message: str) -> None:
        self._reply(status, {"error": message})

    def _read_json(self) -> Optional[dict[str, Any]]:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._fail(411, "缺少 Content-Length")
            return None
        try:
            length = int(raw_length)
        except ValueError:
            self._fail(400, "Content-Length 非法")
            return None
        if length < 0 or length > MAX_BODY_BYTES:
            self._fail(413, "请求体过大")
            return None
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            payload = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            self._fail(400, "请求体必须是 JSON")
            return None
        if not isinstance(payload, dict):
            self._fail(400, "请求体必须是 JSON 对象")
            return None
        return payload

    # ── 路由 ────────────────────────────────────────────────────────────
    def _segments(self) -> tuple[list[str], dict[str, list[str]]]:
        parts = urlsplit(self.path)
        segments = [segment for segment in parts.path.split("/") if segment]
        return segments, parse_qs(parts.query)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler 约定
        segments, query = self._segments()
        try:
            if segments == ["health"]:
                self._reply(200, {"ok": True, "gates": self.server.state.count()})
                return
            if len(segments) == 2 and segments[0] == "gates":
                self._reply(200, self.server.state.get(segments[1]))
                return
            if len(segments) == 3 and segments[0] == "gates" and segments[2] == "wait":
                self._handle_wait(segments[1], query)
                return
            self._fail(404, "未知端点")
        except GateNotFound:
            self._fail(404, "gate 不存在")
        except ValueError as error:
            self._fail(400, str(error))

    def do_POST(self) -> None:  # noqa: N802
        segments, _query = self._segments()
        try:
            if segments == ["gates"]:
                self._handle_create()
                return
            if (
                len(segments) == 3
                and segments[0] == "gates"
                and segments[2] == "release"
            ):
                self._reply(200, self.server.state.release(segments[1]))
                return
            self._fail(404, "未知端点")
        except GateExists:
            self._fail(409, "gate 已存在")
        except GateNotFound:
            self._fail(404, "gate 不存在")

    def do_DELETE(self) -> None:  # noqa: N802
        segments, _query = self._segments()
        try:
            if len(segments) == 2 and segments[0] == "gates":
                self._reply(200, self.server.state.cancel(segments[1]))
                return
            self._fail(404, "未知端点")
        except GateNotFound:
            self._fail(404, "gate 不存在")

    def _handle_create(self) -> None:
        payload = self._read_json()
        if payload is None:
            return
        gate_id = payload.get("id")
        run_id = payload.get("run_id", "")
        if not isinstance(gate_id, str) or not GATE_ID_PATTERN.match(gate_id):
            self._fail(400, "id 必须是 1-128 位安全标识")
            return
        if not isinstance(run_id, str) or len(run_id) > 128:
            self._fail(400, "run_id 必须是不超过 128 字符的字符串")
            return
        self._reply(201, self.server.state.create(gate_id, run_id))

    def _handle_wait(self, gate_id: str, query: dict[str, list[str]]) -> None:
        arrival = (query.get("arrival") or [""])[0]
        if not ARRIVAL_PATTERN.match(arrival):
            raise ValueError("arrival 必须是 1-160 位安全标识")
        raw_timeout = (query.get("timeout") or [None])[0]
        timeout = DEFAULT_WAIT_TIMEOUT
        if raw_timeout is not None:
            try:
                timeout = float(raw_timeout)
            except ValueError as error:
                raise ValueError("timeout 必须是秒数") from error
            if not 0 < timeout <= MAX_WAIT_TIMEOUT:
                raise ValueError(f"timeout 必须在 0..{MAX_WAIT_TIMEOUT} 秒之间")
        started_at = time.monotonic()
        result = self.server.state.wait(gate_id, arrival, timeout)
        result["elapsed_ms"] = int((time.monotonic() - started_at) * 1000)
        self._reply(200, result)


def create_server(
    host: str,
    port: int,
    state: Optional[CoordinatorState] = None,
) -> CoordinatorServer:
    """绑定地址并返回服务实例；port 传 0 由系统分配。"""
    return CoordinatorServer((host, port), state)


def serve_forever(server: CoordinatorServer) -> None:
    server.serve_forever(poll_interval=0.1)


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="NOJ E2E 显式同步屏障协调服务")
    parser.add_argument(
        "--host", default="127.0.0.1", help="监听地址（容器内用 0.0.0.0）"
    )
    parser.add_argument("--port", type=int, default=8010, help="监听端口；0 表示自动分配")
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = _parse_args(argv)
    server = create_server(args.host, args.port)
    bound_host, bound_port = server.server_address[:2]
    # 端口自动分配时必须打印真实地址，供调用方（CI/检查脚本）拼接 URL。
    print(f"test coordinator listening on http://{bound_host}:{bound_port}", flush=True)
    try:
        serve_forever(server)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
