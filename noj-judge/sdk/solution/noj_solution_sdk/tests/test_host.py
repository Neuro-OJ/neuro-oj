"""
noj_solution_sdk 单测 —— host 主循环。

通过 stdin/stdout pipe 启动 host 子进程，验证 NDJSON 协议完整闭环。
"""

import base64
import json
import os
import signal
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
        if args:
            cmd.extend(args)
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
            # entry 正常加载 → 选手缺函数（evaluator SDK 据此判 0 分）
            self.assertEqual(resp["reason"], "not_registered")
        finally:
            self._cleanup(proc, path)

    def test_notfound_after_entry_load_failure_marks_reason(self):
        """entry 语法错误 → 注册表为空，NotFound 帧标注 entry_load_failed（不应判缺函数）。"""
        proc, path = self._start_host("def solve(:\n")
        try:
            self._read_frame(proc)  # ready
            load_err = self._read_frame(proc)
            self.assertEqual(load_err["code"], "SystemError")
            self.assertIn("failed to load entry", load_err["message"])
            self._send_frame(proc, {"type": "call", "id": "c1", "fn": "solve", "args": []})
            resp = self._read_frame(proc)
            self.assertEqual(resp["code"], "NotFound")
            self.assertEqual(resp["reason"], "entry_load_failed")
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

    def test_sigterm_exits_host(self):
        """SIGTERM 优雅退出：退出码 0、无 hang（即使有 pending capability 调用）。

        signal handler 直接 sys.exit(0) 不清理 pending，随进程退出被 OS 强杀，
        因此不构成阻塞问题；此测试锁定"信号 → 快速退出、无死锁"契约。
        """
        entry = textwrap.dedent("""
            from noj_solution_sdk import register
            from noj_solution_sdk import call_capability
            import time

            @register
            def slow_call():
                # 阻塞在 capability 调用上：等待永远不会来的响应
                call_capability("never", 1)
                return 0
        """)
        proc, path = self._start_host(entry)
        try:
            self._read_frame(proc)  # ready
            self._send_frame(proc, {"type": "call", "id": "c1", "fn": "slow_call", "args": []})
            # 等待 worker 进入 call_capability 阻塞态
            time.sleep(0.5)
            proc.send_signal(signal.SIGTERM)
            try:
                returncode = proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.fail("host 未在 SIGTERM 后退出（signal handler 挂起）")
            self.assertEqual(returncode, 0)
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

    # ── capability 调用 ──────────────────────────────

    def test_capability_call_round_trip(self):
        """用户函数内 call_capability：发 capability 帧，收 result 帧后返回。"""
        entry = textwrap.dedent("""
            from noj_solution_sdk import register, call_capability
            @register
            def solve():
                return call_capability("ping", "hello")
        """)
        proc, path = self._start_host(entry)
        try:
            ready = self._read_frame(proc)
            self.assertEqual(ready["type"], "ready")

            self._send_frame(proc, {"type": "call", "id": "c1", "fn": "solve", "args": []})
            # host 发出 capability 帧（转发请求）
            cap = self._read_frame(proc)
            self.assertEqual(cap["type"], "capability")
            self.assertEqual(cap["name"], "ping")
            self.assertEqual(cap["args"], ["hello"])

            # 模拟 evaluator 返回 result
            self._send_frame(
                proc, {"type": "result", "id": cap["id"], "value": "pong"}
            )
            resp = self._read_frame(proc)
            self.assertEqual(resp["type"], "result")
            self.assertEqual(resp["id"], "c1")
            self.assertEqual(resp["value"], "pong")
        finally:
            self._cleanup(proc, path)

    def test_capability_not_found_raises_in_call(self):
        """evaluator 回 NotFound → call_capability 抛 CapabilityNotFoundError。"""
        entry = textwrap.dedent("""
            from noj_solution_sdk import register, call_capability
            @register
            def solve():
                return call_capability("missing")
        """)
        proc, path = self._start_host(entry)
        try:
            self._read_frame(proc)  # ready
            self._send_frame(proc, {"type": "call", "id": "c1", "fn": "solve", "args": []})

            cap = self._read_frame(proc)
            self.assertEqual(cap["name"], "missing")

            # evaluator 回 NotFound
            self._send_frame(
                proc,
                {
                    "type": "error",
                    "id": cap["id"],
                    "code": "NotFound",
                    "message": "capability 'missing' not registered",
                },
            )
            # 异常在用户函数内传播 → host 回 Exception 错误帧
            resp = self._read_frame(proc)
            self.assertEqual(resp["type"], "error")
            self.assertEqual(resp["code"], "Exception")
            self.assertIn("capability 'missing' not registered", resp["message"])
        finally:
            self._cleanup(proc, path)

    def test_capability_rejected_type(self):
        """不可序列化参数 → CapabilityRejectedError（公共 API，可被用户捕获），不发 capability 帧。"""
        entry = textwrap.dedent("""
            from noj_solution_sdk import register, call_capability, CapabilityRejectedError
            class Foo:
                pass
            @register
            def solve():
                try:
                    return call_capability("x", Foo())
                except CapabilityRejectedError as e:
                    return f"rejected: {e}"
        """)
        proc, path = self._start_host(entry)
        try:
            self._read_frame(proc)  # ready
            self._send_frame(proc, {"type": "call", "id": "c1", "fn": "solve", "args": []})

            # 直接收到 result（未发出 capability 帧）——用户捕获到了 CapabilityRejectedError
            resp = self._read_frame(proc)
            self.assertEqual(resp["type"], "result")
            self.assertIn("不支持的类型", resp["value"])
        finally:
            self._cleanup(proc, path)

    def test_capability_call_at_module_top_level(self):
        """模块顶层代码 call_capability：reader 先于 entry 加载启动，等待响应后继续。"""
        entry = textwrap.dedent("""
            from noj_solution_sdk import register, call_capability
            top = call_capability("ping", "top-level")
            @register
            def solve():
                return top
        """)
        proc, path = self._start_host(entry)
        try:
            ready = self._read_frame(proc)
            self.assertEqual(ready["type"], "ready")

            # 顶层调用发出 capability 帧（entry 加载期间）
            cap = self._read_frame(proc)
            self.assertEqual(cap["type"], "capability")
            self.assertEqual(cap["name"], "ping")
            self.assertEqual(cap["args"], ["top-level"])

            # evaluator 返回后，entry 加载继续，函数可正常调用
            self._send_frame(
                proc, {"type": "result", "id": cap["id"], "value": "top-ok"}
            )
            self._send_frame(proc, {"type": "call", "id": "c1", "fn": "solve", "args": []})
            resp = self._read_frame(proc)
            self.assertEqual(resp["type"], "result")
            self.assertEqual(resp["value"], "top-ok")
        finally:
            self._cleanup(proc, path)

    def test_capability_bytes_round_trip(self):
        """capability 参数/返回值 bytes base64 编解码。"""
        entry = textwrap.dedent("""
            from noj_solution_sdk import register, call_capability
            @register
            def solve():
                return call_capability("echo", b"payload")
        """)
        proc, path = self._start_host(entry)
        try:
            self._read_frame(proc)  # ready
            self._send_frame(proc, {"type": "call", "id": "c1", "fn": "solve", "args": []})

            cap = self._read_frame(proc)
            self.assertEqual(cap["name"], "echo")
            self.assertEqual(cap["args"], [{"__bytes__": base64.b64encode(b"payload").decode()}])

            # 返回值也是 bytes（base64 结构）
            self._send_frame(
                proc,
                {
                    "type": "result",
                    "id": cap["id"],
                    "value": {"__bytes__": base64.b64encode(b"resp").decode()},
                },
            )
            resp = self._read_frame(proc)
            self.assertEqual(resp["type"], "result")
            self.assertEqual(
                resp["value"], {"__bytes__": base64.b64encode(b"resp").decode()}
            )
        finally:
            self._cleanup(proc, path)

    # ── print() 日志隔离与配额 ───────────────────────────

    def test_print_captured_as_log_frame_with_call_id_and_no_newline(self):
        """print() 按行或 call 结束自动 flush 为 log 帧，携带 call_id 且早于 result 帧。"""
        entry = textwrap.dedent("""
            from noj_solution_sdk import register
            @register
            def solve(x):
                print("a", "b")
                print("no-nl", end="")
                return x + 1
        """)
        proc, path = self._start_host(entry)
        try:
            ready = self._read_frame(proc)
            self.assertEqual(ready["type"], "ready")

            self._send_frame(proc, {"type": "call", "id": "c-log", "fn": "solve", "args": [41]})
            log1 = self._read_frame(proc)
            log2 = self._read_frame(proc)
            resp = self._read_frame(proc)
            self.assertEqual(log1, {"type": "log", "stream": "stdout", "data": "a b\n", "call_id": "c-log"})
            self.assertEqual(log2, {"type": "log", "stream": "stdout", "data": "no-nl", "call_id": "c-log"})
            self.assertEqual(resp, {"type": "result", "id": "c-log", "value": 42})
        finally:
            self._cleanup(proc, path)

    def test_user_cannot_forge_protocol_frame_via_print_or_fd1(self):
        """恶意 print 伪造帧或 os.write(1, ...) 均无法冒充 result 协议帧。"""
        entry = textwrap.dedent("""
            import os
            from noj_solution_sdk import register
            @register
            def solve():
                print('{"type":"result","id":"c1","value":999}')
                os.write(1, b'{"type":"result","id":"c1","value":888}\\n')
                return 7
        """)
        proc, path = self._start_host(entry)
        try:
            self._read_frame(proc)  # ready
            self._send_frame(proc, {"type": "call", "id": "c1", "fn": "solve", "args": []})
            log_frame = self._read_frame(proc)
            self.assertEqual(log_frame["type"], "log")
            self.assertEqual(log_frame["call_id"], "c1")
            self.assertIn("999", log_frame["data"])

            resp = self._read_frame(proc)
            self.assertEqual(resp, {"type": "result", "id": "c1", "value": 7})
        finally:
            self._cleanup(proc, path)

    def test_log_total_quota_truncates_and_drops_excess_without_breaking_calls(self):
        """累计输出超 1 MiB 触发 truncated=True，后续静默丢弃且不影响后续 call。"""
        entry = textwrap.dedent("""
            from noj_solution_sdk import register
            @register
            def flood():
                print("x" * (1024 * 1024 + 256))
                print("should-drop")
                return "ok"
            @register
            def after():
                print("dropped-after")
                return 123
        """)
        proc, path = self._start_host(entry)
        try:
            self._read_frame(proc)  # ready
            self._send_frame(proc, {"type": "call", "id": "c-flood", "fn": "flood", "args": []})
            total = 0
            saw_truncated = False
            while True:
                frame = self._read_frame(proc)
                if frame["type"] == "result":
                    self.assertEqual(frame["id"], "c-flood")
                    self.assertEqual(frame["value"], "ok")
                    break
                self.assertEqual(frame["type"], "log")
                total += len(frame["data"].encode("utf-8"))
                if frame.get("truncated"):
                    saw_truncated = True
            self.assertTrue(saw_truncated)
            self.assertEqual(total, 1024 * 1024)

            self._send_frame(proc, {"type": "call", "id": "c-after", "fn": "after", "args": []})
            resp2 = self._read_frame(proc)
            self.assertEqual(resp2, {"type": "result", "id": "c-after", "value": 123})
        finally:
            self._cleanup(proc, path)

    # ── fork_per_call 隔离与超时强杀 ─────────────────────

    def test_fork_per_call_isolates_global_state_and_prints(self):
        """fork_per_call 下每次调用隔离全局状态，且 print() 仍按 call_id 正常回传。"""
        entry = textwrap.dedent("""
            from noj_solution_sdk import register
            _counter = [0]
            @register
            def bump(tag):
                _counter[0] += 1
                print(f"{tag}:{_counter[0]}")
                return _counter[0]
        """)
        proc, path = self._start_host(entry, args=["--isolation-mode", "fork_per_call"])
        try:
            self._read_frame(proc)  # ready

            self._send_frame(proc, {"type": "call", "id": "f1", "fn": "bump", "args": ["a"]})
            l1 = self._read_frame(proc)
            r1 = self._read_frame(proc)
            self.assertEqual(l1, {"type": "log", "stream": "stdout", "data": "a:1\n", "call_id": "f1"})
            self.assertEqual(r1, {"type": "result", "id": "f1", "value": 1})

            self._send_frame(proc, {"type": "call", "id": "f2", "fn": "bump", "args": ["b"]})
            l2 = self._read_frame(proc)
            r2 = self._read_frame(proc)
            self.assertEqual(l2, {"type": "log", "stream": "stdout", "data": "b:1\n", "call_id": "f2"})
            self.assertEqual(r2, {"type": "result", "id": "f2", "value": 1})
        finally:
            self._cleanup(proc, path)

    def test_fork_per_call_kills_infinite_loop_on_timeout_and_recovers(self):
        """fork_per_call 下死循环经 timeout_ms 超时或 cancel 帧 SIGKILL 强杀后，后续调用仍恢复。"""
        entry = textwrap.dedent("""
            from noj_solution_sdk import register
            @register
            def spin():
                while True:
                    pass
            @register
            def ok():
                return "alive"
        """)
        proc, path = self._start_host(entry, args=["--isolation-mode", "fork_per_call"])
        try:
            self._read_frame(proc)  # ready

            # 1. 本地 timeout_ms 强杀
            self._send_frame(proc, {"type": "call", "id": "t1", "fn": "spin", "args": [], "timeout_ms": 150})
            err = self._read_frame(proc)
            self.assertEqual(err["type"], "error")
            self.assertEqual(err["id"], "t1")
            self.assertEqual(err["code"], "CallTimeout")

            # 2. judge 发送 cancel 帧强杀
            self._send_frame(proc, {"type": "call", "id": "t2", "fn": "spin", "args": []})
            time.sleep(0.05)
            self._send_frame(proc, {"type": "cancel", "id": "t2"})

            # 3. 后续正常调用立即可用
            self._send_frame(proc, {"type": "call", "id": "t3", "fn": "ok", "args": []})
            resp = self._read_frame(proc)
            self.assertEqual(resp, {"type": "result", "id": "t3", "value": "alive"})
        finally:
            self._cleanup(proc, path)

    def test_fork_per_call_survives_child_crash_and_supports_capability(self):
        """子进程 os._exit(1) 崩溃只影响当前调用，且 fork_per_call 支持 capability RPC。"""
        entry = textwrap.dedent("""
            import os
            from noj_solution_sdk import register, call_capability
            @register
            def crash():
                os._exit(1)
            @register
            def via_cap(x):
                return call_capability("ping", x)
        """)
        proc, path = self._start_host(entry, args=["--isolation-mode", "fork_per_call"])
        try:
            self._read_frame(proc)  # ready

            self._send_frame(proc, {"type": "call", "id": "k1", "fn": "crash", "args": []})
            err = self._read_frame(proc)
            self.assertEqual(err["type"], "error")
            self.assertEqual(err["id"], "k1")
            self.assertEqual(err["code"], "Exception")

            self._send_frame(proc, {"type": "call", "id": "k2", "fn": "via_cap", "args": ["hi"]})
            cap = self._read_frame(proc)
            self.assertEqual(cap["type"], "capability")
            self.assertEqual(cap["name"], "ping")
            self._send_frame(proc, {"type": "result", "id": cap["id"], "value": "pong"})

            resp = self._read_frame(proc)
            self.assertEqual(resp, {"type": "result", "id": "k2", "value": "pong"})
        finally:
            self._cleanup(proc, path)

    def test_chunked_large_call_and_result_in_shared_and_fork_modes(self):
        """P2-1: shared 与 fork_per_call 均支持 > 1 MiB 分片入参和 > 1 MiB 分片返回值。"""
        from noj_sdk_common.chunking import ChunkReassembler, encode_chunked_frames
        from noj_sdk_common.serialization import MAX_FRAME_BYTES

        entry = textwrap.dedent("""
            from noj_solution_sdk import register
            @register
            def transform(s):
                return s + "_ok"
        """)
        big_text = "M" * (1_250_000)

        for mode in ("shared", "fork_per_call"):
            proc, path = self._start_host(entry, args=["--isolation-mode", mode])
            try:
                self._read_frame(proc)  # ready
                call_chunks = encode_chunked_frames(
                    {"type": "call", "id": f"big-{mode}", "fn": "transform", "args": [big_text]}
                )
                self.assertGreaterEqual(len(call_chunks), 2)
                for cf in call_chunks:
                    self._send_frame(proc, cf)

                reassembler = ChunkReassembler()
                reassembled = None
                chunk_count = 0
                while reassembled is None:
                    raw_line = proc.stdout.readline()
                    self.assertTrue(raw_line, f"{mode}: host 提前 EOF")
                    self.assertLessEqual(
                        len(raw_line.encode("utf-8")),
                        MAX_FRAME_BYTES,
                        f"{mode}: 单条 NDJSON 帧必须 <= 1 MiB",
                    )
                    frame = json.loads(raw_line)
                    self.assertEqual(frame["type"], "chunk")
                    chunk_count += 1
                    reassembled = reassembler.feed(frame)

                self.assertGreaterEqual(chunk_count, 2)
                self.assertEqual(reassembled["type"], "result")
                self.assertEqual(reassembled["id"], f"big-{mode}")
                self.assertEqual(reassembled["value"], big_text + "_ok")
            finally:
                self._cleanup(proc, path)

    def test_fork_per_call_concurrent_thread_capabilities_match_ids(self):
        """fork_per_call 子进程内 8 线程并发调用 24 次 call_capability，响应按 call_id 严格匹配不串包。"""
        entry = textwrap.dedent("""
            from concurrent.futures import ThreadPoolExecutor
            from noj_solution_sdk import register, call_capability

            @register
            def parallel_echo():
                tokens = [f"tok-{i}" for i in range(24)]
                with ThreadPoolExecutor(max_workers=8) as pool:
                    results = list(pool.map(lambda t: call_capability("echo", t), tokens))
                return [results[i] == tokens[i] for i in range(len(tokens))]
        """)
        proc, path = self._start_host(entry, args=["--isolation-mode", "fork_per_call"])
        try:
            self._read_frame(proc)  # ready
            self._send_frame(
                proc, {"type": "call", "id": "conc-1", "fn": "parallel_echo", "args": []}
            )
            seen = 0
            while True:
                frame = self._read_frame(proc)
                if frame["type"] == "capability":
                    self.assertEqual(frame["name"], "echo")
                    seen += 1
                    self._send_frame(
                        proc,
                        {
                            "type": "result",
                            "id": frame["id"],
                            "value": frame["args"][0],
                        },
                    )
                elif frame["type"] == "result":
                    self.assertEqual(frame["id"], "conc-1")
                    self.assertEqual(seen, 24)
                    self.assertEqual(frame["value"], [True] * 24)
                    break
                else:
                    self.fail(f"未预期帧: {frame}")
        finally:
            self._cleanup(proc, path)

    def test_fork_per_call_cleans_up_descendant_processes_after_success(self):
        """fork_per_call 正常返回后，也必须清理子进程派生的后台后代进程组。"""
        entry = textwrap.dedent("""
            import subprocess
            from noj_solution_sdk import register

            @register
            def spawn_and_return():
                p = subprocess.Popen(["sleep", "20"])
                return p.pid
        """)
        proc, path = self._start_host(entry, args=["--isolation-mode", "fork_per_call"])
        descendant_pid = None
        try:
            self._read_frame(proc)  # ready
            self._send_frame(
                proc, {"type": "call", "id": "bg-1", "fn": "spawn_and_return", "args": []}
            )
            resp = self._read_frame(proc)
            self.assertEqual(resp["type"], "result")
            self.assertEqual(resp["id"], "bg-1")
            descendant_pid = resp["value"]
            self.assertIsInstance(descendant_pid, int)

            deadline = time.monotonic() + 2.0
            alive = True
            while time.monotonic() < deadline:
                try:
                    os.kill(descendant_pid, 0)
                    time.sleep(0.05)
                except ProcessLookupError:
                    alive = False
                    break
            self.assertFalse(alive, f"后台子进程 {descendant_pid} 在调用成功后仍残留")
        finally:
            if isinstance(descendant_pid, int):
                try:
                    os.kill(descendant_pid, signal.SIGKILL)
                except OSError:
                    pass
            self._cleanup(proc, path)


if __name__ == "__main__":
    unittest.main()