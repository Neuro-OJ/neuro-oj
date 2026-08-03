"""
noj_evaluator_sdk SolutionRunner。

单方向阻塞调用 Solution host 中的注册函数：

    runner = SolutionRunner()
    value = runner.call("solve", 1, 2)

内部：
- 启动一个后台线程从 stdin 读 NDJSON 响应帧
- 按 `id` 字段匹配 pending 调用
- `runner.call()` 写 `call` 帧到 stdout，阻塞等响应
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import traceback
import uuid
from queue import Empty, Queue
from typing import Any, Optional

from .capability import _get_capability
from .errors import (
    ConnectionError,
    NotFoundError,
    RejectedError,
    SolutionTimeoutError,
    SystemError,
)
from .serialization import (
    check_frame_size,
    decode_value,
    encode_value,
    validate_type,
)

_TB_FILE_RE = re.compile(r'File "([^"]+)"')


def _sanitize_traceback(exc: BaseException) -> str:
    """清洗 traceback：文件路径只保留 basename（与 solution 侧 sanitize_trace 对齐）。

    error 帧会返回给 solution（做题人），不得泄露 evaluator 容器内部绝对路径。
    """
    lines = traceback.format_exception(type(exc), exc, exc.__traceback__)
    cleaned = [
        _TB_FILE_RE.sub(lambda m: f'File "{os.path.basename(m.group(1))}"', line)
        for line in lines
    ]
    return "".join(cleaned)


class SolutionRunner:
    """阻塞式 Solution host 调用器。

    生命周期与 evaluate.py 进程一致。单实例即可复用。
    """

    def __init__(self) -> None:
        self._pending: dict[str, Queue] = {}
        self._lock = threading.Lock()
        self._closed = False
        # stdout 写入锁：call 帧（主线程）与 capability 响应（reader 线程）并发写
        self._out_lock = threading.Lock()
        self._reader_thread = threading.Thread(
            target=self._reader_loop, name="noj-evaluator-stdin-reader", daemon=True
        )
        self._reader_thread.start()

    # ── 公开 API ────────────────────────────────────────

    def call(self, fn: str, *args: Any) -> Any:
        """调用 Solution host 中的函数 `fn`。

        返回值由 SDK 自动反序列化（bytes base64 → bytes 等）。

        抛出：
            SolutionTimeoutError  - 单次调用超时（host 进程仍存活）
            NotFoundError         - 函数未注册
            RejectedError         - 参数/返回值类型不允许
            ConnectionError       - IPC 通道断开（host 进程崩溃）
            SystemError           - 其他 host 内部错误
        """
        if self._closed:
            raise ConnectionError("runner 已关闭")

        # 1. 参数校验
        for i, arg in enumerate(args):
            validate_type(arg, f"arg[{i}]")

        # 2. 构造 call 帧
        call_id = uuid.uuid4().hex
        frame = {
            "type": "call",
            "id": call_id,
            "fn": fn,
            "args": [encode_value(a) for a in args],
        }

        # 3. 注册 pending
        q: Queue = Queue(maxsize=1)
        with self._lock:
            self._pending[call_id] = q

        # 4. 写帧到 stdout
        try:
            self._write_out(frame)
        except RejectedError:
            with self._lock:
                self._pending.pop(call_id, None)
            raise

        # 5. 阻塞等响应（超时由 judge 端 call_timeout_ms 控制，
        #    SDK 这里不设超时——避免与 judge 双重超时逻辑混淆）
        try:
            response = q.get()
        except Exception as e:
            with self._lock:
                self._pending.pop(call_id, None)
            raise ConnectionError(f"等待响应异常: {e}")

        # 6. 处理响应
        with self._lock:
            self._pending.pop(call_id, None)
        return self._handle_response(response)

    def close(self) -> None:
        """主动关闭 runner（通常不需要，进程结束自动清理）。"""
        self._closed = True

    # ── 内部 ────────────────────────────────────────────

    def _reader_loop(self) -> None:
        """后台线程：从 stdin 持续读 NDJSON 帧，分发到对应 pending queue。"""
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    frame = json.loads(line)
                except json.JSONDecodeError as e:
                    # 非 JSON 行被静默忽略（可能是 host 误输出，但协议约束应保证不发生）
                    sys.stderr.write(
                        f"[noj_evaluator_sdk] stdin 非 JSON 帧: {e}: {line!r}\n"
                    )
                    sys.stderr.flush()
                    continue

                frame_type = frame.get("type")
                frame_id = frame.get("id")

                if frame_type == "capability":
                    # solution 请求调用 capability：查注册表并同步执行（写响应帧）
                    self._handle_capability(frame)
                elif frame_type in ("result", "error"):
                    with self._lock:
                        q = self._pending.pop(frame_id, None)
                    if q is not None:
                        q.put(frame)
                    # else: 响应已超时丢弃，忽略
                elif frame_type == "log":
                    # log 帧直接打到 stderr（judge 也会收集并截断）
                    stream = frame.get("stream", "stdout")
                    data = frame.get("data", "")
                    target = sys.stderr if stream == "stderr" else sys.stdout
                    # 注意：log 流到 stdout 会污染协议帧，故日志统一走 stderr
                    sys.stderr.write(data)
                    if not data.endswith("\n"):
                        sys.stderr.write("\n")
                    sys.stderr.flush()
                elif frame_type == "shutdown":
                    self._closed = True
                    # 唤醒所有 pending（会抛 ConnectionError）
                    with self._lock:
                        for q in self._pending.values():
                            try:
                                q.put_nowait({"type": "_shutdown"})
                            except Exception:
                                pass
                        self._pending.clear()
                # 其它 type 忽略
        except (EOFError, BrokenPipeError):
            # stdin 关闭 → 整体失败
            self._closed = True
            with self._lock:
                for q in self._pending.values():
                    try:
                        q.put_nowait({"type": "_shutdown"})
                    except Exception:
                        pass
                self._pending.clear()
        except Exception as e:
            sys.stderr.write(f"[noj_evaluator_sdk] reader_loop 异常: {e}\n")
            sys.stderr.flush()
            self._closed = True

    def _write_out(self, frame: dict) -> None:
        """线程安全写 NDJSON 帧到 stdout（受单帧 1 MiB 软上限约束）。"""
        line = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
        check_frame_size(line)
        with self._out_lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def _handle_capability(self, frame: dict) -> None:
        """处理 solution 的 capability 调用（在 reader 线程同步执行）。

        语义：
        - 未注册 → error 帧 code=NotFound
        - 参数/返回值类型非法 → error 帧 code=Rejected
        - handler 异常 → error 帧 code=Exception（含 trace）
        - 成功 → result 帧（value 经 codec 编码）
        """
        cap_id = frame.get("id")
        name = frame.get("name", "")
        args = frame.get("args", [])

        handler = _get_capability(name)
        if handler is None:
            self._write_out(
                {
                    "type": "error",
                    "id": cap_id,
                    "code": "NotFound",
                    "message": f"capability {name!r} not registered",
                }
            )
            return

        try:
            decoded_args = [decode_value(a) for a in args]
            result = handler(*decoded_args)
            # 返回值类型校验（与 runner.call 相同的 RPC 类型契约）
            validate_type(result, "<capability result>")
            encoded = encode_value(result)
            # 帧大小校验放在 try 内：超大返回值按 Rejected 回给 solution。
            # （_write_out 内部也会校验，但那里的异常会逃逸到 reader 循环，
            #   导致响应帧丢失、solution 侧挂起至评测超时）
            result_frame = {"type": "result", "id": cap_id, "value": encoded}
            line = json.dumps(result_frame, ensure_ascii=False, separators=(",", ":"))
            check_frame_size(line)
        except RejectedError as e:
            self._write_out(
                {"type": "error", "id": cap_id, "code": "Rejected", "message": str(e)}
            )
            return
        except Exception as e:
            self._write_out(
                {
                    "type": "error",
                    "id": cap_id,
                    "code": "Exception",
                    "message": str(e),
                    "trace": _sanitize_traceback(e),
                }
            )
            return

        self._write_out(result_frame)

    def _handle_response(self, frame: dict) -> Any:
        """处理 result/error 帧，抛出对应异常或返回值。"""
        if frame.get("type") == "_shutdown":
            raise ConnectionError("Solution host 已关闭 / IPC 通道断开")

        if frame.get("type") == "error":
            code = frame.get("code", "SystemError")
            message = frame.get("message", "")
            if code == "Timeout":
                raise SolutionTimeoutError(message)
            if code == "NotFound":
                raise NotFoundError(message)
            if code == "Rejected":
                raise RejectedError(message)
            # Exception / SystemError 等
            if code == "Exception":
                trace = frame.get("trace", "")
                exc = SystemError(f"{message}\n{trace}".strip())
                exc.trace = trace
                raise exc
            raise SystemError(f"{code}: {message}")

        # type == 'result'
        value = frame.get("value")
        return decode_value(value)