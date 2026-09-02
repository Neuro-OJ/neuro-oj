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
import sys
import threading
import uuid
from typing import Any, Optional

from noj_sdk_common.rpc import RpcClient
from noj_sdk_common.sanitize import sanitize_message, sanitize_traceback

from .capability import _get_capability
from .errors import (
    ConnectionError,
    NotFoundError,
    RejectedError,
    SolutionTimeoutError,
    SystemError,
)
from .serialization import (
    MAX_FRAME_BYTES,
    check_frame_size,
    decode_value,
    encode_value,
    estimate_frame_size,
    validate_type,
)


class SolutionRunner:
    """阻塞式 Solution host 调用器。

    生命周期与 evaluate.py 进程一致。单实例即可复用。
    """

    def __init__(self) -> None:
        self._rpc = RpcClient()
        self._closed = False
        self._reader_thread = threading.Thread(
            target=self._reader_loop, name="noj-evaluator-stdin-reader", daemon=True
        )
        self._reader_thread.start()

    # ── 公开 API ────────────────────────────────────────

    def call(self, fn: str, *args: Any, timeout_ms: Optional[int] = None) -> Any:
        """调用 Solution host 中的函数 `fn`。

        `timeout_ms`：本次调用的超时（毫秒）。None = 由 judge 回退题目级默认；
        正整数 = 按调用指定。0 / 负数 / 非 int 抛 ValueError。

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

        # 0. timeout_ms 校验（None 或正整数；type is int 排除 bool）
        if timeout_ms is not None:
            if type(timeout_ms) is not int or timeout_ms <= 0:
                raise ValueError(
                    f"timeout_ms 必须是正整数或 None，实际 {timeout_ms!r}"
                )

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
        if timeout_ms is not None:
            frame["timeout_ms"] = timeout_ms

        # 3. 注册 pending
        q = self._rpc.register_pending(call_id)

        # 4. 写帧到 stdout
        try:
            self._write_out(frame)
        except RejectedError:
            self._rpc.pop_pending(call_id)
            raise

        # 5. 阻塞等响应（超时由 judge 端 call_timeout_ms 控制，
        #    SDK 这里不设超时——避免与 judge 双重超时逻辑混淆）
        try:
            response = q.get()
        except Exception as e:
            self._rpc.pop_pending(call_id)
            raise ConnectionError(f"等待响应异常: {e}")

        # 6. 处理响应
        self._rpc.pop_pending(call_id)
        return self._handle_response(response)

    def close(self) -> None:
        """主动关闭 runner（通常不需要，进程结束自动清理）。"""
        self._closed = True
        self._rpc.close()

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

                if frame_type == "capability":
                    # solution 请求调用 capability：查注册表并同步执行（写响应帧）
                    self._handle_capability(frame)
                elif frame_type in ("result", "error"):
                    self._rpc.deliver_response(frame)
                elif frame_type == "log":
                    # log 帧直接打到 stderr（judge 也会收集并截断）
                    stream = frame.get("stream", "stdout")
                    data = frame.get("data", "")
                    # 注意：log 流到 stdout 会污染协议帧，故日志统一走 stderr
                    sys.stderr.write(data)
                    if not data.endswith("\n"):
                        sys.stderr.write("\n")
                    sys.stderr.flush()
                elif frame_type == "shutdown":
                    self._closed = True
                    self._rpc.shutdown_pending()
                # 其它 type 忽略
        except (EOFError, BrokenPipeError):
            # stdin 关闭 → 整体失败
            self._closed = True
            self._rpc.shutdown_pending()
        except Exception as e:
            sys.stderr.write(f"[noj_evaluator_sdk] reader_loop 异常: {e}\n")
            sys.stderr.flush()
            self._closed = True

    def _write_out(self, frame: dict) -> None:
        """线程安全写 NDJSON 帧到 stdout（受单帧 1 MiB 软上限约束）。"""
        line = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
        check_frame_size(line)
        self._rpc.write_frame(frame)

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
            # 大小预检：在 encode_value（bytes → base64 膨胀 ~1.33×）之前估算，
            # 超大返回值直接拒绝，避免先吃完整序列化内存（防恶意输出拖垮 evaluator）
            if estimate_frame_size(result) > MAX_FRAME_BYTES:
                raise RejectedError(
                    f"capability 返回值过大（估算序列化 > {MAX_FRAME_BYTES} 字节，"
                    "单帧 1 MiB 软上限）"
                )
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
                    "message": sanitize_message(str(e)),
                    "trace": sanitize_traceback(e),
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
            if code == "CallTimeout":
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
