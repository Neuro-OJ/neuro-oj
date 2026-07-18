"""
noj_solution_sdk 单测 —— host 主循环。

通过 stdin/stdout pipe 启动 host 子进程，验证 NDJSON 协议完整闭环。
"""

import base64
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest


HOST_PY = "noj_solution_sdk.host"


class TestHostProcess(unittest.TestCase):
    """启动 host 进程，端到端验证 NDJSON 协议。"""

    def _start_host(self, entry_source: str, args=None):
        """把 entry 写到临时文件，启动 host 子进程。返回 (proc, entry_path)。"""
        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False
        )
        tmp.write(entry_source)
        tmp.close()

        cmd = [sys.executable, "-m", HOST_PY, "--entry", tmp.name]
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,  # line buffered
        )
        return proc, tmp.name

    def _read_frame(self, proc, timeout=5.0):
        """从 proc.stdout 读一行 NDJSON。"""
        # 阻塞读单行（子进程 line buffering）
        line = proc.stdout.readline()
        if not line:
            # 可能 EOF 或超时
            err = proc.stderr.read()
            raise RuntimeError(f"host 关闭；stderr={err!r}")
        return json.loads(line.strip())

    def _send_frame(self, proc, frame: dict):
        proc.stdin.write(json.dumps(frame) + "\n")
        proc.stdin.flush()

    def _cleanup(self, proc, tmp_path):
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            proc.kill()
        except Exception:
            pass
        proc.wait(timeout=5)
        os.unlink(tmp_path)

    # ── 测试用例 ──────────────────────────────────────

    def test_host_sends_ready_on_startup(self):
        entry = textwrap.dedent("""
            from noj_solution_sdk import register
            @register
            def solve(a, b):
                return a + b
        """)
        proc, path = self._start_host(entry)
        try:
            frame = self._read_frame(proc)
            self.assertEqual(frame["type"], "ready")
        finally:
            self._cleanup(proc, path)

    def test_basic_call_round_trip(self):
        entry = textwrap.dedent("""
            from noj_solution_sdk import register
            @register
            def solve(a, b):
                return a + b
        """)
        proc, path = self._start_host(entry)
        try:
            ready = self._read_frame(proc)
            self.assertEqual(ready["type"], "ready")

            self._send_frame(proc, {"type": "call", "id": "c1", "fn": "solve", "args": [1, 2]})
            resp = self._read_frame(proc)
            self.assertEqual(resp["type"], "result")
            self.assertEqual(resp["id"], "c1")
            self.assertEqual(resp["value"], 3)
        finally:
            self._cleanup(proc, path)

    def test_unknown_function_returns_notfound(self):
        entry = textwrap.dedent("""
            from noj_solution_sdk import register
            @register
            def solve():
                return 0
        """)
        proc, path = self._start_host(entry)
        try:
            self._read_frame(proc)  # ready
            self._send_frame(proc, {"type": "call", "id": "c1", "fn": "missing", "args": []})
            resp = self._read_frame(proc)
            self.assertEqual(resp["type"], "error")
            self.assertEqual(resp["code"], "NotFound")
        finally:
            self._cleanup(proc, path)

    def test_user_exception_returns_exception_error(self):
        entry = textwrap.dedent("""
            from noj_solution_sdk import register
            @register
            def bad():
                raise ValueError("intentional boom")
        """)
        proc, path = self._start_host(entry)
        try:
            self._read_frame(proc)  # ready
            self._send_frame(proc, {"type": "call", "id": "c1", "fn": "bad", "args": []})
            resp = self._read_frame(proc)
            self.assertEqual(resp["type"], "error")
            self.assertEqual(resp["code"], "Exception")
            self.assertIn("intentional boom", resp["message"])
            # trace 应已 sanitize
            self.assertIn("trace", resp)
            self.assertIn("ValueError: intentional boom", resp["trace"])
            # trace 不应含绝对路径
            self.assertNotIn("/usr/local/lib", resp["trace"])
        finally:
            self._cleanup(proc, path)

    def test_persistent_state_across_calls(self):
        """同一 host 内多次调用，全局状态应保留。"""
        entry = textwrap.dedent("""
            from noj_solution_sdk import register
            _counter = [0]
            @register
            def increment():
                _counter[0] += 1
                return _counter[0]
            @register
            def get():
                return _counter[0]
        """)
        proc, path = self._start_host(entry)
        try:
            self._read_frame(proc)  # ready

            self._send_frame(proc, {"type": "call", "id": "c1", "fn": "increment", "args": []})
            resp1 = self._read_frame(proc)
            self.assertEqual(resp1["value"], 1)

            self._send_frame(proc, {"type": "call", "id": "c2", "fn": "increment", "args": []})
            resp2 = self._read_frame(proc)
            self.assertEqual(resp2["value"], 2)

            self._send_frame(proc, {"type": "call", "id": "c3", "fn": "get", "args": []})
            resp3 = self._read_frame(proc)
            self.assertEqual(resp3["value"], 2)
        finally:
            self._cleanup(proc, path)

    def test_shutdown_exits_host(self):
        entry = textwrap.dedent("""
            from noj_solution_sdk import register
            @register
            def noop():
                return 0
        """)
        proc, path = self._start_host(entry)
        try:
            self._read_frame(proc)  # ready
            self._send_frame(proc, {"type": "shutdown"})
            # host 应在 5s 内退出
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.fail("host 未在 shutdown 后退出")
        finally:
            self._cleanup(proc, path)

    def test_duplicate_register_raises_on_load(self):
        """entry 内重复注册同名函数时，host 加载失败但仍能 ready + 接收 shutdown。"""
        entry = textwrap.dedent("""
            from noj_solution_sdk import register
            @register
            def solve():
                return 1
            register("solve", lambda: 2)  # 重复注册 → 抛错
        """)
        proc, path = self._start_host(entry)
        try:
            # entry 加载失败时仍发 ready 帧
            ready = self._read_frame(proc)
            self.assertEqual(ready["type"], "ready")
            # 不应再能调用 solve（注册表里可能仍包含一个，但语义不保证）
            # 直接发 shutdown 验证 host 不死锁
            self._send_frame(proc, {"type": "shutdown"})
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.fail("host 在 entry 加载失败后无法响应 shutdown")
        finally:
            self._cleanup(proc, path)

    def test_bytes_args_round_trip(self):
        """bytes 经 base64 round-trip。"""
        entry = textwrap.dedent("""
            import base64
            from noj_solution_sdk import register
            @register
            def echo(data):
                return data
        """)
        proc, path = self._start_host(entry)
        try:
            self._read_frame(proc)
            encoded = {"__bytes__": base64.b64encode(b"hello").decode()}
            self._send_frame(
                proc, {"type": "call", "id": "c1", "fn": "echo", "args": [encoded]}
            )
            resp = self._read_frame(proc)
            self.assertEqual(resp["type"], "result")
            self.assertEqual(resp["value"], encoded)  # bytes 仍以 base64 形式回到 caller
        finally:
            self._cleanup(proc, path)


if __name__ == "__main__":
    unittest.main()