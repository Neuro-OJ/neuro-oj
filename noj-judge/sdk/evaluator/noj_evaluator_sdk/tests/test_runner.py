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


class TestSolutionRunnerCall(unittest.TestCase):
    """验证 call → response 闭环。"""

    def _run_call(self, harness, fn, *args, timeout=2.0):
        """后台线程跑 runner.call，主线程 join 等结果。返回 (value, error)。"""
        result_box = {}
        err_box = {}

        def runner():
            try:
                result_box["v"] = harness.runner.call(fn, *args)
            except Exception as e:
                err_box["e"] = e

        t = threading.Thread(target=runner)
        t.start()
        # 等帧写出
        time.sleep(0.05)
        return t, result_box, err_box

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
                    "code": "Timeout",
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
            results = {}
            errors = {}

            def make_call(key, fn, arg):
                def runner():
                    try:
                        results[key] = h.runner.call(fn, arg)
                    except Exception as e:
                        errors[key] = e

                return runner

            t1 = threading.Thread(target=make_call("a", "f1", 1))
            t2 = threading.Thread(target=make_call("b", "f2", 2))
            t1.start()
            t2.start()
            time.sleep(0.1)

            lines = h.all_call_frames()
            self.assertEqual(len(lines), 2)
            id_a = next(l["id"] for l in lines if l["fn"] == "f1")
            id_b = next(l["id"] for l in lines if l["fn"] == "f2")

            # 乱序回响应
            h.send_host_response({"type": "result", "id": id_b, "value": "second"})
            h.send_host_response({"type": "result", "id": id_a, "value": "first"})

            t1.join(timeout=2)
            t2.join(timeout=2)
            self.assertEqual(results.get("a"), "first")
            self.assertEqual(results.get("b"), "second")
        finally:
            h.teardown()


if __name__ == "__main__":
    unittest.main()