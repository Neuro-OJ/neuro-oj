"""核对 E2E 同步屏障协调服务的契约（临时端口，不接触任何外部栈）。

覆盖：
- 健康检查、创建/查询、重复 gate 409；
- 并发 wait 不被单线程服务阻塞，release 唤醒全部等待者且幂等；
- 相同 nonce 不重复计数；
- DELETE 取消并唤醒等待者、清理后 404；
- 等待超时上报 timed_out 且不误报释放；
- 日志不打印 nonce 等请求细节；
- 退出后无遗留线程与监听连接；
- CLI 的 --port 0 会打印真实地址。

任一条不满足都以非零退出码结束，供 CI 与本地直接当门禁运行。
"""

import contextlib
import io
import json
import re
import socket
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from test_coordinator import (
    DEFAULT_WAIT_TIMEOUT,
    CoordinatorServer,
    CoordinatorState,
)

SCRIPT = Path(__file__).resolve().parent / "test_coordinator.py"


def call(base, method, path, body=None, timeout=60):
    """发一个 JSON 请求；HTTP 错误状态也要返回响应体。"""
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    request = Request(base + path, data=data, method=method, headers=headers)
    try:
        with urlopen(request, timeout=timeout) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        with error:
            return error.code, json.load(error)


def wait_for_arrivals(base, gate_id, expected, timeout=5.0, interval=0.02):
    """轮询 gate 状态直到到达数达到 expected；超时返回最后一次快照。

    注意不能把「到达数」直接当布尔条件用：arrivals=1 已经是真值，会在第二个
    等待者注册前就提前返回（曾导致偶发假失败）。
    """
    deadline = time.monotonic() + timeout
    status = call(base, "GET", f"/gates/{gate_id}")[1]
    while status["arrivals"] < expected and time.monotonic() < deadline:
        time.sleep(interval)
        status = call(base, "GET", f"/gates/{gate_id}")[1]
    return status


class CoordinatorContract(unittest.TestCase):
    def setUp(self):
        self.server = CoordinatorServer(("127.0.0.1", 0), CoordinatorState())
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.05},
            daemon=True,
        )
        self.thread.start()
        host, port = self.server.server_address[:2]
        self.base = f"http://{host}:{port}"
        self._waiters = []
        self._gates = []

    def tearDown(self):
        # 断言失败时也要先唤醒等待者，否则线程会阻塞到 45 秒屏障超时，
        # 真正的失败原因会被「等待线程未退出」掩盖。
        for gate_id in self._gates:
            call(self.base, "DELETE", f"/gates/{gate_id}")
        for waiter in self._waiters:
            waiter.join(5)
        self.assertFalse(
            [writer for writer in self._waiters if writer.is_alive()],
            "等待线程未在清理后退出",
        )
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)

    def create_gate(self, gate_id, run_id="r"):
        self._gates.append(gate_id)
        return call(
            self.base, "POST", "/gates", {"id": gate_id, "run_id": run_id}
        )

    def start_wait(self, gate_id, arrival, timeout=None):
        """后台发起一次阻塞 wait，返回线程与结果容器。"""
        result = {}

        def run():
            path = f"/gates/{gate_id}/wait?arrival={arrival}"
            if timeout is not None:
                path += f"&timeout={timeout}"
            try:
                result["response"] = call(self.base, "GET", path, timeout=120)
            except Exception as error:  # noqa: BLE001 - 失败原因要原样带进断言
                result["error"] = error

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self._waiters.append(thread)
        return thread, result

    def test_health_create_and_conflict(self):
        status, health = call(self.base, "GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(health, {"ok": True, "gates": 0})

        status, created = self.create_gate("run-a", "run-a")
        self.assertEqual(status, 201)
        self.assertEqual(created["arrivals"], 0)
        self.assertFalse(created["released"])
        self.assertFalse(created["cancelled"])
        self.assertEqual(created["waiting"], 0)

        status, conflict = call(
            self.base, "POST", "/gates", {"id": "run-a", "run_id": "run-a"}
        )
        self.assertEqual(status, 409)
        self.assertIn("error", conflict)

        status, state = call(self.base, "GET", "/gates/run-a")
        self.assertEqual(status, 200)
        self.assertEqual(state["arrivals"], 0)

        status, missing = call(self.base, "GET", "/gates/other-run")
        self.assertEqual(status, 404)
        self.assertIn("error", missing)

        status, _ = call(self.base, "POST", "/gates", {"run_id": "no-id"})
        self.assertEqual(status, 400)

    def test_wait_blocks_then_release_wakes_all(self):
        self.create_gate("gates-release")
        first, first_result = self.start_wait("gates-release", "a-one")
        second, second_result = self.start_wait("gates-release", "a-two")

        # 阻塞中的 wait 不能独占服务：查询请求必须立即返回，否则就是单线程 HTTPServer。
        snapshot = wait_for_arrivals(self.base, "gates-release", 2)
        self.assertEqual(snapshot["arrivals"], 2, "两个等待者都必须被记录")
        self.assertEqual(first_result, {})
        self.assertEqual(second_result, {})
        status, snapshot = call(self.base, "GET", "/gates/gates-release")
        self.assertEqual(status, 200)
        self.assertFalse(snapshot["released"])
        self.assertGreaterEqual(snapshot["waiting"], 1)

        status, released = call(
            self.base, "POST", "/gates/gates-release/release", {}
        )
        self.assertEqual(status, 200)
        self.assertTrue(released["released"])
        first.join(5)
        second.join(5)
        for result in (first_result, second_result):
            self.assertIn("response", result)
            status, payload = result["response"]
            self.assertEqual(status, 200)
            self.assertTrue(payload["released"])
            self.assertFalse(payload["timed_out"])
            self.assertEqual(payload["arrivals"], 2)

        # 幂等 release：重复调用保持已释放，后到的 wait 立即通过。
        status, again = call(self.base, "POST", "/gates/gates-release/release", {})
        self.assertEqual(status, 200)
        self.assertTrue(again["released"])
        started_at = time.monotonic()
        status, later = call(
            self.base, "GET", "/gates/gates-release/wait?arrival=a-three"
        )
        elapsed = time.monotonic() - started_at
        self.assertEqual(status, 200)
        self.assertTrue(later["released"])
        self.assertFalse(later["timed_out"])
        self.assertEqual(later["arrivals"], 3)
        self.assertLess(elapsed, 2.0, "已释放的 gate 必须立即通过")
        call(self.base, "DELETE", "/gates/gates-release")

    def test_same_nonce_counts_once(self):
        self.create_gate("gates-nonce")
        first, first_result = self.start_wait("gates-nonce", "same-nonce")
        self.assertEqual(
            wait_for_arrivals(self.base, "gates-nonce", 1)["arrivals"],
            1,
        )
        second, second_result = self.start_wait("gates-nonce", "same-nonce")
        time.sleep(0.2)
        status, snapshot = call(self.base, "GET", "/gates/gates-nonce")
        self.assertEqual(status, 200)
        self.assertEqual(snapshot["arrivals"], 1, "相同 nonce 不能重复计数")
        self.assertTrue(first.is_alive() and second.is_alive())

        call(self.base, "POST", "/gates/gates-nonce/release", {})
        first.join(5)
        second.join(5)
        self.assertEqual(first_result["response"][1]["arrivals"], 1)
        self.assertEqual(second_result["response"][1]["arrivals"], 1)
        call(self.base, "DELETE", "/gates/gates-nonce")

    def test_delete_cancels_waiters_and_cleanup(self):
        self.create_gate("gates-cancel")
        waiter, result = self.start_wait("gates-cancel", "arrival-cancel")
        self.assertEqual(
            wait_for_arrivals(self.base, "gates-cancel", 1)["arrivals"],
            1,
        )
        status, cancelled = call(self.base, "DELETE", "/gates/gates-cancel")
        self.assertEqual(status, 200)
        self.assertTrue(cancelled["cancelled"])
        waiter.join(5)
        self.assertFalse(waiter.is_alive())
        self.assertIn("response", result)
        status, payload = result["response"]
        self.assertEqual(status, 200)
        self.assertTrue(payload["cancelled"])
        self.assertFalse(payload["released"])
        self.assertFalse(payload["timed_out"])
        self.assertEqual(call(self.base, "GET", "/gates/gates-cancel")[0], 404)
        self.assertEqual(
            call(self.base, "GET", "/gates/gates-cancel/wait?arrival=x")[0], 404
        )
        self.assertEqual(call(self.base, "DELETE", "/gates/gates-cancel")[0], 404)

    def test_wait_timeout_and_limit(self):
        # 屏障上限必须短于 evaluator 的 60 秒总时限。
        self.assertEqual(DEFAULT_WAIT_TIMEOUT, 45.0)
        self.assertLess(DEFAULT_WAIT_TIMEOUT, 60)

        self.create_gate("gates-timeout")
        status, payload = call(
            self.base, "GET", "/gates/gates-timeout/wait?arrival=slow&timeout=0.2"
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["timed_out"])
        self.assertFalse(payload["released"])
        self.assertFalse(payload["cancelled"])
        self.assertGreaterEqual(payload["elapsed_ms"], 150)
        status, _ = call(
            self.base, "GET", "/gates/gates-timeout/wait?arrival=x&timeout=999"
        )
        self.assertEqual(status, 400, "超上限的等待时间必须被拒绝")
        self.assertEqual(
            call(self.base, "GET", "/gates/gates-timeout/wait")[0], 400
        )
        call(self.base, "DELETE", "/gates/gates-timeout")

    def test_logs_do_not_leak_request_details(self):
        secret_nonce = "secret-nonce-4f9c2b"
        buffer = io.StringIO()
        with contextlib.redirect_stderr(buffer):
            self.create_gate("gates-log", "secret-run")
            call(
                self.base,
                "GET",
                f"/gates/gates-log/wait?arrival={secret_nonce}&timeout=0.1",
                timeout=10,
            )
            call(self.base, "POST", "/gates/gates-log/release", {})
            call(self.base, "DELETE", "/gates/gates-log")
        log = buffer.getvalue()
        self.assertIn("GET /gates/gates-log/wait 200", log)
        self.assertNotIn(secret_nonce, log, "日志不能打印屏障 nonce")
        self.assertNotIn("Authorization", log)
        self.assertNotIn("secret-run", log)

    def test_no_leftover_threads_or_connections(self):
        baseline = set(threading.enumerate())
        server = CoordinatorServer(("127.0.0.1", 0), CoordinatorState())
        thread = threading.Thread(
            target=server.serve_forever,
            kwargs={"poll_interval": 0.05},
            daemon=True,
        )
        thread.start()
        host, port = server.server_address[:2]
        base = f"http://{host}:{port}"
        waiter = threading.Thread(
            target=lambda: call(
                base, "GET", "/gates/leftover/wait?arrival=a", timeout=30
            ),
            daemon=True,
        )
        try:
            call(base, "POST", "/gates", {"id": "leftover", "run_id": "r"})
            waiter.start()
            self.assertEqual(
                wait_for_arrivals(base, "leftover", 1)["arrivals"],
                1,
            )
            call(base, "POST", "/gates/leftover/release", {})
            waiter.join(5)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)

        with self.assertRaises(OSError):
            socket.create_connection((host, port), timeout=0.5).close()
        deadline = time.monotonic() + 3
        leftover = set(threading.enumerate()) - baseline
        while leftover and time.monotonic() < deadline:
            time.sleep(0.05)
            leftover = set(threading.enumerate()) - baseline
        self.assertEqual(leftover, set(), f"存在遗留线程: {leftover}")

    def test_cli_prints_actual_port(self):
        process = subprocess.Popen(
            [sys.executable, "-B", str(SCRIPT), "--host", "127.0.0.1", "--port", "0"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        try:
            line = process.stdout.readline().strip()
            match = re.search(r"http://127\.0\.0\.1:(\d+)", line)
            self.assertIsNotNone(match, f"未打印实际地址: {line!r}")
            base = f"http://127.0.0.1:{match.group(1)}"
            status, health = call(base, "GET", "/health", timeout=10)
            self.assertEqual(status, 200)
            self.assertEqual(health, {"ok": True, "gates": 0})
        finally:
            process.terminate()
            try:
                process.wait(5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(5)


if __name__ == "__main__":
    unittest.main()
