"""
noj_evaluator_sdk 单测 —— SolutionRunner。

用 stdlib 启动 SolutionRunner，把它的 stdin/stdout 拦截到内存中，
mock 一个"假 host"线程往 SolutionRunner 的 stdin 写响应帧。

注：StringIO 在 `for line in sys.stdin` 模式下会在迭代开始时锁定内容快照，
导致 write 后续内容无效。本测试改用 BlockingPipe 模拟真实 stdin。
"""

import io
import json
import sys
import threading
import time
import unittest

sys.path.insert(0, sys.path[0] + "/..")

from noj_evaluator_sdk.errors import (
    ConnectionError,
    NotFoundError,
    RejectedError,
    SolutionTimeoutError,
)
from noj_evaluator_sdk.runner import SolutionRunner


class BlockingPipe:
    """模拟真实 stdin：readline() 阻塞直到有数据写入。

    同时实现 `__iter__` / `__next__` 兼容 `for line in sys.stdin` 模式。
    """

    def __init__(self):
        self._buffer = ""
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._closed = False
        self._eof = False

    def write(self, data: str):
        with self._cond:
            self._buffer += data
            self._cond.notify_all()

    def readline(self) -> str:
        with self._cond:
            while True:
                if self._eof and not self._buffer:
                    return ""
                if self._closed:
                    return ""
                idx = self._buffer.find("\n")
                if idx >= 0:
                    line = self._buffer[: idx + 1]
                    self._buffer = self._buffer[idx + 1 :]
                    return line
                self._cond.wait()

    def __iter__(self):
        return self

    def __next__(self) -> str:
        line = self.readline()
        if line == "":
            raise StopIteration
        return line

    def close(self):
        with self._cond:
            self._closed = True
            self._cond.notify_all()


class IpcHarness:
    """构造 SolutionRunner，把它的 stdin/stdout 拦截到内存管道。"""

    def __init__(self):
        self.runner_stdout_buf = io.StringIO()  # SolutionRunner 写的内容（host 视角读）
        self.runner_stdin_pipe = BlockingPipe()  # host 写，SolutionRunner 读

        self._orig_stdout = sys.stdout
        self._orig_stdin = sys.stdin
        sys.stdout = self.runner_stdout_buf
        sys.stdin = self.runner_stdin_pipe

        self.runner = SolutionRunner()
        self._call_threads: list = []

    def start_call(self, fn, *args, **kwargs):
        """后台 daemon 线程跑 runner.call，返回 (thread, result_box, err_box)。

        daemon=True：即便测试失败、pending 未被唤醒，也不会阻止测试进程退出。
        """
        result_box = {}
        err_box = {}

        def target():
            try:
                result_box["v"] = self.runner.call(fn, *args, **kwargs)
            except Exception as e:
                err_box["e"] = e

        t = threading.Thread(target=target, daemon=True)
        self._call_threads.append(t)
        t.start()
        return t, result_box, err_box

    def wait_for_frames(self, count: int = 1, timeout: float = 2.0) -> list:
        """轮询 stdout，直到至少写出 `count` 个帧（替代固定 sleep，消除时序抖动）。"""
        deadline = time.monotonic() + timeout
        while True:
            frames = self.all_call_frames()
            if len(frames) >= count:
                return frames
            if time.monotonic() >= deadline:
                raise AssertionError(
                    f"等待 {count} 个帧超时（{timeout}s），实际 {len(frames)} 个"
                )
            time.sleep(0.005)

    def send_host_response(self, frame: dict):
        self.runner_stdin_pipe.write(json.dumps(frame) + "\n")

    def last_call_frame(self) -> dict:
        content = self.runner_stdout_buf.getvalue()
        lines = [l for l in content.split("\n") if l.strip()]
        assert len(lines) > 0, "SolutionRunner 未写入任何 call 帧"
        return json.loads(lines[-1])

    def all_call_frames(self) -> list:
        content = self.runner_stdout_buf.getvalue()
        return [json.loads(l) for l in content.split("\n") if l.strip()]

    def teardown(self):
        sys.stdin = self._orig_stdin
        sys.stdout = self._orig_stdout
        self.runner_stdin_pipe.close()
        self.runner.close()
        # 唤醒仍阻塞在 q.get() 的 call 线程：线程可能在 close() 之后才注册
        # pending，故循环 shutdown_pending 直到线程退出（有上限，避免卡死）
        deadline = time.monotonic() + 2.0
        for t in self._call_threads:
            while t.is_alive() and time.monotonic() < deadline:
                self.runner._rpc.shutdown_pending()
                t.join(timeout=0.01)


class TestSolutionRunnerCall(unittest.TestCase):
    """验证 call → response 闭环。"""

    def _run_call(self, harness, fn, *args, **kwargs):
        """后台线程跑 runner.call，并等待 call 帧写出。返回 (thread, results, errors)。"""
        before = len(harness.all_call_frames())  # 须在启动线程前计数，否则自身也有竞态
        started = harness.start_call(fn, *args, **kwargs)
        harness.wait_for_frames(before + 1)
        return started

    def test_basic_call_returns_value(self):
        h = IpcHarness()
        try:
            t, results, errors = self._run_call(h, "solve", 1, 2)
            call_frame = h.last_call_frame()
            self.assertEqual(call_frame["type"], "call")
            self.assertEqual(call_frame["fn"], "solve")
            self.assertEqual(call_frame["args"], [1, 2])

            h.send_host_response(
                {"type": "result", "id": call_frame["id"], "value": 3}
            )
            t.join(timeout=2)
            self.assertFalse(t.is_alive(), "call 未在超时内返回")
            self.assertIn("v", results, f"call 未返回，err={errors}")
            self.assertEqual(results["v"], 3)
        finally:
            h.teardown()

    def test_call_with_kwargs_args(self):
        h = IpcHarness()
        try:
            t, results, errors = self._run_call(h, "solve", 1, 2, "x", None, True)
            call_frame = h.last_call_frame()
            self.assertEqual(call_frame["args"], [1, 2, "x", None, True])

            h.send_host_response(
                {"type": "result", "id": call_frame["id"], "value": "ok"}
            )
            t.join(timeout=2)
            self.assertFalse(t.is_alive())
            self.assertEqual(results["v"], "ok")
        finally:
            h.teardown()

    def test_call_returns_bytes_value(self):
        h = IpcHarness()
        try:
            import base64

            t, results, errors = self._run_call(h, "get_bytes")
            call_frame = h.last_call_frame()
            encoded = {"__bytes__": base64.b64encode(b"hello").decode()}
            h.send_host_response(
                {"type": "result", "id": call_frame["id"], "value": encoded}
            )
            t.join(timeout=2)
            self.assertFalse(t.is_alive())
            self.assertEqual(results.get("v"), b"hello")
        finally:
            h.teardown()

    def test_call_returns_list_dict(self):
        h = IpcHarness()
        try:
            t, results, errors = self._run_call(h, "get_struct")
            call_frame = h.last_call_frame()
            h.send_host_response(
                {
                    "type": "result",
                    "id": call_frame["id"],
                    "value": {"a": [1, 2, "x"], "b": None},
                }
            )
            t.join(timeout=2)
            self.assertFalse(t.is_alive())
            self.assertEqual(results.get("v"), {"a": [1, 2, "x"], "b": None})
        finally:
            h.teardown()

    def test_call_raises_not_found(self):
        h = IpcHarness()
        try:
            t, _, errors = self._run_call(h, "missing")
            call_frame = h.last_call_frame()
            h.send_host_response(
                {
                    "type": "error",
                    "id": call_frame["id"],
                    "code": "NotFound",
                    "message": "function 'missing' not registered",
                }
            )
            t.join(timeout=2)
            self.assertIsInstance(errors.get("e"), NotFoundError)
        finally:
            h.teardown()

    def test_call_raises_timeout(self):
        h = IpcHarness()
        try:
            t, _, errors = self._run_call(h, "slow_fn")
            call_frame = h.last_call_frame()
            h.send_host_response(
                {
                    "type": "error",
                    "id": call_frame["id"],
                    "code": "CallTimeout",
                    "message": "exceeded 500ms",
                }
            )
            t.join(timeout=2)
            self.assertIsInstance(errors.get("e"), SolutionTimeoutError)
        finally:
            h.teardown()

    def test_call_raises_rejected_on_bad_param_type(self):
        """客户端参数类型不允许时本地就抛 RejectedError。"""
        h = IpcHarness()
        try:
            with self.assertRaises(RejectedError):
                h.runner.call("f", {1, 2, 3})  # set 不允许
        finally:
            h.teardown()

    def test_call_raises_connection_error_on_host_shutdown(self):
        """host 发 shutdown 帧 → pending call 抛 ConnectionError。"""
        h = IpcHarness()
        try:
            t, _, errors = self._run_call(h, "slow")
            # host 主动发 shutdown
            h.send_host_response({"type": "shutdown"})
            t.join(timeout=2)
            self.assertIsInstance(errors.get("e"), ConnectionError)
        finally:
            h.teardown()

    def test_multiple_concurrent_calls(self):
        """两个并发 call 应该独立完成。"""
        h = IpcHarness()
        try:
            t1, results_a, _ = h.start_call("f1", 1)
            t2, results_b, _ = h.start_call("f2", 2)
            lines = h.wait_for_frames(2)
            self.assertEqual(len(lines), 2)
            id_a = next(l["id"] for l in lines if l["fn"] == "f1")
            id_b = next(l["id"] for l in lines if l["fn"] == "f2")

            # 乱序回响应
            h.send_host_response({"type": "result", "id": id_b, "value": "second"})
            h.send_host_response({"type": "result", "id": id_a, "value": "first"})

            t1.join(timeout=2)
            t2.join(timeout=2)
            self.assertEqual(results_a.get("v"), "first")
            self.assertEqual(results_b.get("v"), "second")
        finally:
            h.teardown()

    def test_call_frame_with_timeout_ms(self):
        """指定 timeout_ms 时 call 帧应带该字段。"""
        harness = IpcHarness()
        try:
            t, _, _ = self._run_call(harness, "solve", 1, timeout_ms=5000)
            frame = harness.last_call_frame()
            self.assertEqual(frame.get("timeout_ms"), 5000)
            harness.send_host_response(
                {"type": "result", "id": frame["id"], "value": 3}
            )
            t.join(timeout=2.0)
            self.assertFalse(t.is_alive(), "call 应已返回")
        finally:
            harness.teardown()

    def test_call_frame_without_timeout_ms(self):
        """缺省 timeout_ms 时 call 帧不应带该字段（向后兼容）。"""
        harness = IpcHarness()
        try:
            t, _, _ = self._run_call(harness, "solve", 1)
            frame = harness.last_call_frame()
            self.assertNotIn("timeout_ms", frame)
            harness.send_host_response(
                {"type": "result", "id": frame["id"], "value": 3}
            )
            t.join(timeout=2.0)
            self.assertFalse(t.is_alive(), "call 应已返回")
        finally:
            harness.teardown()

    def test_call_invalid_timeout_ms_raises(self):
        """timeout_ms 为 0 / 负数 / 非 int（含 bool）时抛 ValueError。"""
        harness = IpcHarness()
        try:
            for bad in (0, -1, "5000", True):
                with self.assertRaises(ValueError):
                    harness.runner.call("solve", 1, timeout_ms=bad)
            # 非法值不应发出 call 帧
            self.assertEqual(len(harness.all_call_frames()), 0)
        finally:
            harness.teardown()


class TestCapability(unittest.TestCase):
    """验证 capability 帧处理（register_capability → handler → 响应帧）。"""

    def _wait_for_frames(self, harness, timeout=2.0):
        """轮询 stdout，等待 reader 线程写出帧。返回所有帧列表。"""
        try:
            return harness.wait_for_frames(1, timeout=timeout)
        except AssertionError:
            self.fail("capability 响应帧未在超时内写出")

    def test_capability_round_trip(self):
        from noj_evaluator_sdk.capability import (
            _reset_capabilities_for_tests,
            register_capability,
        )

        _reset_capabilities_for_tests()

        def ping(msg: str) -> str:
            return f"pong:{msg}"

        register_capability("ping", ping)
        h = IpcHarness()
        try:
            h.send_host_response(
                {"type": "capability", "id": "cap1", "name": "ping", "args": ["hello"]}
            )
            frames = self._wait_for_frames(h)
            resp = frames[-1]
            self.assertEqual(resp["type"], "result")
            self.assertEqual(resp["id"], "cap1")
            self.assertEqual(resp["value"], "pong:hello")
        finally:
            h.teardown()
            _reset_capabilities_for_tests()

    def test_capability_not_found(self):
        from noj_evaluator_sdk.capability import (
            _reset_capabilities_for_tests,
        )

        _reset_capabilities_for_tests()
        h = IpcHarness()
        try:
            h.send_host_response(
                {"type": "capability", "id": "cap2", "name": "nope", "args": []}
            )
            frames = self._wait_for_frames(h)
            resp = frames[-1]
            self.assertEqual(resp["type"], "error")
            self.assertEqual(resp["code"], "NotFound")
            self.assertIn("nope", resp["message"])
        finally:
            h.teardown()
            _reset_capabilities_for_tests()

    def test_capability_handler_exception(self):
        from noj_evaluator_sdk.capability import (
            _reset_capabilities_for_tests,
            register_capability,
        )

        _reset_capabilities_for_tests()

        def boom():
            raise ValueError("cap boom")

        register_capability("boom", boom)
        h = IpcHarness()
        try:
            h.send_host_response(
                {"type": "capability", "id": "cap3", "name": "boom", "args": []}
            )
            frames = self._wait_for_frames(h)
            resp = frames[-1]
            self.assertEqual(resp["type"], "error")
            self.assertEqual(resp["code"], "Exception")
            self.assertIn("cap boom", resp["message"])
            self.assertIn("ValueError", resp.get("trace", ""))
            # trace 应已清洗：不含绝对路径（防泄露 evaluator 内部路径）
            self.assertNotIn("/workspace/", resp.get("trace", ""))
            self.assertNotIn("noj_evaluator_sdk", resp.get("trace", ""))
        finally:
            h.teardown()
            _reset_capabilities_for_tests()

    def test_capability_handler_exception_message_sanitized(self):
        """F3：handler 异常 message 必须清洗——绝对路径 basename 化、超长截断。"""
        from noj_evaluator_sdk.capability import (
            _reset_capabilities_for_tests,
            register_capability,
        )

        _reset_capabilities_for_tests()

        def leaky():
            raise ValueError(
                f"failed at /workspace/secret/path/credentials.py, token=abc123"
                + "x" * 5000  # 超长 message
            )

        register_capability("leaky", leaky)
        h = IpcHarness()
        try:
            h.send_host_response(
                {"type": "capability", "id": "cap7", "name": "leaky", "args": []}
            )
            frames = self._wait_for_frames(h)
            resp = frames[-1]
            self.assertEqual(resp["type"], "error")
            self.assertEqual(resp["code"], "Exception")
            # 绝对路径被 basename 化（不再泄露 evaluator 内部目录结构）
            self.assertNotIn("/workspace/", resp["message"])
            self.assertIn("credentials.py", resp["message"])
            # 超长 message 被截断（上限 ~1024 字符）
            self.assertLess(len(resp["message"]), 2048)
            self.assertIn("截断", resp["message"])
        finally:
            h.teardown()
            _reset_capabilities_for_tests()

    def test_capability_oversize_bytes_rejected_before_encode(self):
        """F2：超大 bytes 返回值在 encode_value（base64 膨胀）之前即被估算拒绝。"""
        from noj_evaluator_sdk.capability import (
            _reset_capabilities_for_tests,
            register_capability,
        )

        _reset_capabilities_for_tests()

        def big_bytes():
            return b"x" * (1024 * 1024 + 4096)  # 编码后必超 1 MiB

        register_capability("big_bytes", big_bytes)
        h = IpcHarness()
        try:
            h.send_host_response(
                {"type": "capability", "id": "cap8", "name": "big_bytes", "args": []}
            )
            frames = self._wait_for_frames(h)
            resp = frames[-1]
            self.assertEqual(resp["type"], "error")
            self.assertEqual(resp["code"], "Rejected")
            self.assertIn("返回值过大", resp["message"])
        finally:
            h.teardown()
            _reset_capabilities_for_tests()

    def test_capability_overwrite_wins(self):
        from noj_evaluator_sdk.capability import (
            _reset_capabilities_for_tests,
            register_capability,
        )

        _reset_capabilities_for_tests()
        register_capability("dup", lambda: "first")
        register_capability("dup", lambda: "second")
        h = IpcHarness()
        try:
            h.send_host_response(
                {"type": "capability", "id": "cap4", "name": "dup", "args": []}
            )
            frames = self._wait_for_frames(h)
            resp = frames[-1]
            self.assertEqual(resp["type"], "result")
            self.assertEqual(resp["value"], "second")
        finally:
            h.teardown()
            _reset_capabilities_for_tests()

    def test_capability_rejected_return_type(self):
        from noj_evaluator_sdk.capability import (
            _reset_capabilities_for_tests,
            register_capability,
        )

        _reset_capabilities_for_tests()

        def bad_return():
            return object()  # 不可序列化

        register_capability("bad", bad_return)
        h = IpcHarness()
        try:
            h.send_host_response(
                {"type": "capability", "id": "cap5", "name": "bad", "args": []}
            )
            frames = self._wait_for_frames(h)
            resp = frames[-1]
            self.assertEqual(resp["type"], "error")
            self.assertEqual(resp["code"], "Rejected")
        finally:
            h.teardown()
            _reset_capabilities_for_tests()

    def test_capability_result_too_large_rejected(self):
        """超大返回值（序列化后 > 1 MiB）：必须回 Rejected 帧，而不是丢失响应。"""
        from noj_evaluator_sdk.capability import (
            _reset_capabilities_for_tests,
            register_capability,
        )

        _reset_capabilities_for_tests()

        def big_return():
            return "x" * (1024 * 1024 + 1024)  # 超过单帧 1 MiB 软上限

        register_capability("big", big_return)
        h = IpcHarness()
        try:
            h.send_host_response(
                {"type": "capability", "id": "cap6", "name": "big", "args": []}
            )
            frames = self._wait_for_frames(h)
            resp = frames[-1]
            self.assertEqual(resp["type"], "error")
            self.assertEqual(resp["code"], "Rejected")
            # 预检生效：encode 前估算拒绝，message 说明返回值过大
            self.assertIn("返回值过大", resp["message"])
        finally:
            h.teardown()
            _reset_capabilities_for_tests()

    def test_register_capability_with_timeout_emits_cap_reg(self):
        """注册时配置 timeout_ms → stdout 写 cap_reg 帧。"""
        from noj_evaluator_sdk import register_capability
        from noj_evaluator_sdk.capability import _reset_capabilities_for_tests
        harness = IpcHarness()
        try:
            register_capability("ping", lambda x: x, timeout_ms=9000)
            frames = harness.all_call_frames()
            reg = [f for f in frames if f.get("type") == "cap_reg"]
            self.assertEqual(len(reg), 1)
            self.assertEqual(reg[0]["name"], "ping")
            self.assertEqual(reg[0]["timeout_ms"], 9000)
        finally:
            harness.teardown()
            _reset_capabilities_for_tests()

    def test_register_capability_without_timeout_emits_cap_reg_no_field(self):
        from noj_evaluator_sdk import register_capability
        from noj_evaluator_sdk.capability import _reset_capabilities_for_tests
        harness = IpcHarness()
        try:
            register_capability("ping2", lambda x: x)
            frames = harness.all_call_frames()
            reg = [f for f in frames if f.get("type") == "cap_reg"]
            self.assertEqual(len(reg), 1)
            self.assertEqual(reg[0]["name"], "ping2")
            self.assertNotIn("timeout_ms", reg[0])
        finally:
            harness.teardown()
            _reset_capabilities_for_tests()

    def test_register_capability_invalid_timeout_raises(self):
        from noj_evaluator_sdk import register_capability
        from noj_evaluator_sdk.capability import _reset_capabilities_for_tests
        with self.assertRaises(ValueError):
            register_capability("bad", lambda x: x, timeout_ms=0)
        _reset_capabilities_for_tests()


class TestRpcClientShutdownRace(unittest.TestCase):
    """RpcClient：关闭后注册 pending 必须即时拿到哨兵帧（消除注册/唤醒竞态，#680）。"""

    def test_register_after_close_returns_shutdown_frame(self):
        from noj_sdk_common.rpc import RpcClient

        rpc = RpcClient()
        rpc.close()
        q = rpc.register_pending("late")
        self.assertEqual(q.get(timeout=1), {"type": "_shutdown"})

    def test_register_after_shutdown_pending_returns_shutdown_frame(self):
        from noj_sdk_common.rpc import RpcClient

        rpc = RpcClient()
        rpc.shutdown_pending()
        q = rpc.register_pending("late")
        self.assertEqual(q.get(timeout=1), {"type": "_shutdown"})

    def test_shutdown_pending_idempotent(self):
        from noj_sdk_common.rpc import RpcClient

        rpc = RpcClient()
        rpc.shutdown_pending()
        rpc.shutdown_pending()  # 幂等，不应抛
        q = rpc.register_pending("late")
        self.assertEqual(q.get(timeout=1), {"type": "_shutdown"})

    def test_registered_pending_woken_by_shutdown(self):
        from noj_sdk_common.rpc import RpcClient

        rpc = RpcClient()
        q = rpc.register_pending("x")
        rpc.shutdown_pending()
        self.assertEqual(q.get(timeout=1), {"type": "_shutdown"})


class TestShutdownWakeups(unittest.TestCase):
    """#680：IPC 断开（EOF / reader 异常 / 并发 close）必须唤醒 pending call。"""

    def _run_call(self, harness, fn, *args, **kwargs):
        before = len(harness.all_call_frames())
        started = harness.start_call(fn, *args, **kwargs)
        harness.wait_for_frames(before + 1)
        return started

    def test_call_raises_connection_error_on_stdin_eof(self):
        """stdin 正常 EOF（host 退出）应唤醒 pending call → ConnectionError。"""
        h = IpcHarness()
        try:
            t, _, errors = self._run_call(h, "slow")
            # 模拟 host 退出：stdin EOF（for 迭代静默结束，不抛 EOFError）
            h.runner_stdin_pipe.close()
            t.join(timeout=3)
            self.assertFalse(t.is_alive(), "stdin EOF 后 call 未返回（#680 回归）")
            self.assertIsInstance(errors.get("e"), ConnectionError)
            self.assertTrue(h.runner._closed, "EOF 后 runner 应标记为已关闭")
        finally:
            h.teardown()

    def test_reader_exception_wakes_pending(self):
        """reader 循环抛未知异常也应唤醒 pending call → ConnectionError。"""

        def boom(_frame):
            raise RuntimeError("reader boom")

        h = IpcHarness()
        orig = h.runner._handle_capability
        h.runner._handle_capability = boom  # type: ignore[method-assign]
        try:
            t, _, errors = self._run_call(h, "slow")
            # 触发 reader 处理下一帧 → 走 boom → 外层 except → finally 唤醒
            h.send_host_response(
                {"type": "capability", "id": "c", "name": "x", "args": []}
            )
            t.join(timeout=3)
            self.assertFalse(t.is_alive(), "reader 异常后 call 未返回（#680 回归）")
            self.assertIsInstance(errors.get("e"), ConnectionError)
        finally:
            h.runner._handle_capability = orig  # type: ignore[method-assign]
            h.teardown()

    def test_close_and_call_race_never_hangs(self):
        """close 与 call 并发时 call 必须终止（不得永久阻塞，#680）。"""
        for _ in range(15):
            h = IpcHarness()
            try:
                t, _, _ = h.start_call("f", 1)
                # 并发关闭：可能早于 call 的 _closed 检查，也可能晚于 register
                h.runner.close()
                t.join(timeout=2.0)
                self.assertFalse(
                    t.is_alive(),
                    "close 与 call 并发时 call 未在超时内终止（#680 回归）",
                )
            finally:
                h.teardown()


class TestSolutionLogCapture(unittest.TestCase):
    """Solution log 帧按 call_id 隔离捕获、默认不泄题写 stderr、超 8 KiB 截断。"""

    def test_call_logs_isolated_by_call_id_and_not_written_to_stderr_by_default(self):
        h = IpcHarness()
        orig_stderr = sys.stderr
        stderr_buf = io.StringIO()
        sys.stderr = stderr_buf
        try:
            # import 期无 call_id 的日志
            h.send_host_response({"type": "log", "stream": "stdout", "data": "boot-log\n"})

            t1, res1, _ = h.start_call("solve", 1)
            f1 = h.wait_for_frames(1)[0]
            h.send_host_response({"type": "log", "stream": "stdout", "data": "call1-a\n", "call_id": f1["id"]})
            h.send_host_response({"type": "log", "stream": "stdout", "data": "call1-b", "call_id": f1["id"]})
            h.send_host_response({"type": "result", "id": f1["id"], "value": 10})
            t1.join(timeout=2)

            self.assertEqual(res1["v"], 10)
            self.assertEqual(h.runner.last_call_logs, "call1-a\ncall1-b")
            self.assertFalse(h.runner.last_call_logs_truncated)
            self.assertEqual(stderr_buf.getvalue(), "")
            self.assertEqual(h.runner.pop_logs(), "boot-log\n")

            # 抛 SystemError 时仍能读取该 call_id 的日志
            t2, _, err2 = h.start_call("solve", 2)
            f2 = h.wait_for_frames(2)[1]
            h.send_host_response({"type": "log", "stream": "stdout", "data": "before-crash\n", "call_id": f2["id"]})
            h.send_host_response({"type": "error", "id": f2["id"], "code": "Exception", "message": "boom"})
            t2.join(timeout=2)

            self.assertIn("e", err2)
            self.assertEqual(h.runner.last_call_logs, "before-crash\n")
        finally:
            sys.stderr = orig_stderr
            h.teardown()

    def test_call_logs_truncated_at_8kb_and_optional_stderr_forwarding(self):
        orig_stderr = sys.stderr
        stderr_buf = io.StringIO()
        sys.stderr = stderr_buf
        h = IpcHarness()
        h.runner._forward_solution_logs_to_stderr = True
        try:
            t1, _, _ = h.start_call("solve")
            f1 = h.wait_for_frames(1)[0]
            h.send_host_response({"type": "log", "stream": "stdout", "data": "a" * 9000, "call_id": f1["id"]})
            h.send_host_response({"type": "result", "id": f1["id"], "value": 1})
            t1.join(timeout=2)

            self.assertTrue(h.runner.last_call_logs_truncated)
            self.assertEqual(len(h.runner.last_call_logs.encode("utf-8")), 8 * 1024)
            self.assertIn("a" * 100, stderr_buf.getvalue())
        finally:
            sys.stderr = orig_stderr
            h.teardown()


class TestChunkedLargePayloadRpc(unittest.TestCase):
    """P2-1: 超过 1 MiB 的 call 参数与 result 返回值透明分片传输与重组。"""

    def test_large_call_and_large_result_roundtrip_via_chunks(self):
        from noj_sdk_common.chunking import ChunkReassembler, encode_chunked_frames
        from noj_sdk_common.serialization import MAX_FRAME_BYTES, encode_value

        h = IpcHarness()
        try:
            big_arg = "A" * (1_300_000)
            t, res, err = h.start_call("echo_big", big_arg, timeout_ms=4321)

            # 等待多个 chunk 帧写出，且每条物理 NDJSON 行严格 <= 1 MiB
            deadline = time.monotonic() + 3.0
            frames = []
            while time.monotonic() < deadline:
                raw_lines = [
                    ln
                    for ln in h.runner_stdout_buf.getvalue().splitlines()
                    if ln.strip()
                ]
                if raw_lines:
                    frames = [json.loads(ln) for ln in raw_lines]
                    if frames[0].get("type") == "chunk" and len(frames) == frames[0].get("total"):
                        for ln in raw_lines:
                            self.assertLessEqual(len(ln.encode("utf-8")), MAX_FRAME_BYTES)
                        break
                time.sleep(0.01)

            self.assertGreaterEqual(len(frames), 2)
            self.assertEqual(frames[0]["type"], "chunk")
            self.assertEqual(frames[0]["kind"], "call")
            self.assertEqual(frames[0]["timeout_ms"], 4321)

            reassembler = ChunkReassembler()
            call_frame = None
            for f in frames:
                call_frame = reassembler.feed(f)
            self.assertIsNotNone(call_frame)
            assert call_frame is not None
            self.assertEqual(call_frame["fn"], "echo_big")
            self.assertEqual(call_frame["args"][0], big_arg)

            # 模拟 host 返回 > 1 MiB bytes（经 base64 编码 + 分片）
            big_bytes = b"Z" * (1_100_000)
            resp_chunks = encode_chunked_frames(
                {"type": "result", "id": call_frame["id"], "value": encode_value(big_bytes)}
            )
            self.assertGreaterEqual(len(resp_chunks), 2)
            for cf in resp_chunks:
                h.send_host_response(cf)

            t.join(timeout=3.0)
            self.assertFalse(t.is_alive())
            self.assertNotIn("e", err)
            self.assertEqual(res["v"], big_bytes)
        finally:
            h.teardown()

    def test_oversize_payload_above_chunk_limit_rejected(self):
        h = IpcHarness()
        try:
            # 构造超出 16 MiB 默认上限的载荷，预检应直接抛出 RejectedError
            huge = "x" * (17 * 1024 * 1024)
            with self.assertRaises(RejectedError):
                h.runner.call("echo_big", huge)
        finally:
            h.teardown()

    def test_large_numeric_batch_below_limit_not_false_rejected(self):
        """[0] * 700_000 实际 JSON 约 1.4 MB（< 16 MiB），不得被上界预检误拒。"""
        from noj_sdk_common.chunking import ChunkReassembler

        h = IpcHarness()
        try:
            batch = [0] * 700_000
            t, res, err = h.start_call("echo_batch", batch)

            deadline = time.monotonic() + 5.0
            frames = []
            while time.monotonic() < deadline:
                raw_lines = [
                    ln
                    for ln in h.runner_stdout_buf.getvalue().splitlines()
                    if ln.strip()
                ]
                if raw_lines:
                    frames = [json.loads(ln) for ln in raw_lines]
                    if frames[0].get("type") == "chunk" and len(frames) == frames[0].get("total"):
                        break
                time.sleep(0.01)

            self.assertGreaterEqual(len(frames), 2)
            reassembler = ChunkReassembler()
            call_frame = None
            for f in frames:
                call_frame = reassembler.feed(f)
            self.assertIsNotNone(call_frame)
            assert call_frame is not None
            self.assertEqual(len(call_frame["args"][0]), 700_000)

            h.send_host_response({"type": "result", "id": call_frame["id"], "value": 700_000})
            t.join(timeout=3.0)
            self.assertFalse(t.is_alive())
            self.assertNotIn("e", err)
            self.assertEqual(res["v"], 700_000)
        finally:
            h.teardown()

    def test_reassembler_rejects_excessive_and_empty_chunks(self):
        """恶意超大 total 或多分片空载荷必须被拦截，不得在内存中累积状态。"""
        from noj_sdk_common.chunking import ChunkReassembler

        r = ChunkReassembler(max_payload_bytes=1 * 1024 * 1024)
        # 1) total 超过允许分片上限：直接拒绝，不创建流缓冲
        for seq in range(200):
            out = r.feed(
                {"type": "chunk", "stream_id": "flood", "seq": seq, "total": 100_000, "data": ""}
            )
            self.assertIsNone(out)
        self.assertEqual(len(r._streams), 0)

        # 2) total 合法但多分片携带空载荷：直接丢弃流，不保留空表项
        out = r.feed({"type": "chunk", "stream_id": "empty-parts", "seq": 0, "total": 10, "data": ""})
        self.assertIsNone(out)
        self.assertEqual(len(r._streams), 0)


if __name__ == "__main__":
    unittest.main()