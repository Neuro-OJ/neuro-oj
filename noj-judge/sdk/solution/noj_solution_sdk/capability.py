"""
noj_solution_sdk capability 调用层。

用户代码通过 `call_capability(name, *args)` 请求 evaluator 执行已注册的能力
（如受限网络请求）。调用经 judge 转发到 evaluator，响应按 `id` 匹配返回。

与 evaluator 侧 `runner.call()` 相同的 RPC 契约：
- 参数/返回值仅允许 None / bool / int / float / str / bytes / list / dict
- 单帧不超过 MAX_FRAME_BYTES（1 MiB）
"""

from __future__ import annotations

import json
import sys
import threading
import uuid
from queue import Empty, Queue
from typing import Any

from .serialization import (
    MAX_FRAME_BYTES,
    _RejectedTypeError,
    check_frame_size,
    decode_value,
    encode_value,
    validate_type,
)


class CapabilityNotFoundError(Exception):
    """evaluator 未注册该 capability。"""


class CapabilityRejectedError(Exception):
    """参数/返回值类型不允许或帧超限。"""


class CapabilityConnectionError(Exception):
    """IPC 通道断开（host 进程关闭）。"""


class CapabilityError(Exception):
    """evaluator 侧 handler 执行异常（含清洗后 traceback）。"""

    def __init__(self, message: str, code: str = "SystemError", trace: str = ""):
        super().__init__(message)
        self.code = code
        self.trace = trace


# pending 调用：call_id → Queue（线程安全）
_PENDING: dict[str, Queue] = {}
_PENDING_LOCK = threading.Lock()
# stdout 写入锁（多线程下保证 NDJSON 帧原子写入）
_STDOUT_LOCK = threading.Lock()


def _write_frame(frame: dict) -> None:
    """写 NDJSON 帧到 stdout（一行 + 换行），线程安全。"""
    line = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
    with _STDOUT_LOCK:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def _deliver_response(frame: dict) -> None:
    """按 id 分发 result/error 帧到对应 pending 队列（由 host reader 线程调用）。"""
    frame_id = frame.get("id")
    if frame_id is None:
        return
    with _PENDING_LOCK:
        q = _PENDING.pop(frame_id, None)
    if q is not None:
        q.put(frame)


def _shutdown_pending() -> None:
    """唤醒所有 pending 调用（连接断开/关闭时）。"""
    with _PENDING_LOCK:
        pending = list(_PENDING.values())
        _PENDING.clear()
    for q in pending:
        try:
            q.put_nowait({"type": "_shutdown"})
        except Exception:
            pass


def call_capability(name: str, *args: Any) -> Any:
    """调用 evaluator 注册的 capability。

    阻塞等待 evaluator 响应（无单次超时；评测总超时兜底）。

    抛出：
        CapabilityNotFoundError - capability 未注册
        CapabilityRejectedError - 参数类型不允许 / 帧超限
        CapabilityError         - handler 执行异常（code + 清洗后 traceback）
        CapabilityConnectionError - IPC 通道断开
    """
    if not isinstance(name, str) or not name.strip():
        raise CapabilityRejectedError(f"capability 名称必须是非空字符串，实际 {type(name).__name__}")

    # 1. 参数类型校验（与 runner.call 相同的 RPC 类型契约）
    #    内部 _RejectedTypeError 必须转换为公开的 CapabilityRejectedError，
    #    否则用户代码收到无法 import 的私有异常（文档承诺的公共 API）
    try:
        for i, arg in enumerate(args):
            validate_type(arg, f"arg[{i}]")
    except _RejectedTypeError as e:
        raise CapabilityRejectedError(str(e)) from e

    # 2. 构造 capability 帧
    call_id = uuid.uuid4().hex
    frame = {
        "type": "capability",
        "id": call_id,
        "name": name,
        "args": [encode_value(a) for a in args],
    }

    # 3. 帧大小校验（对齐 MAX_FRAME_BYTES = 1 MiB）
    try:
        line = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
        check_frame_size(line)
    except _RejectedTypeError as e:
        raise CapabilityRejectedError(str(e)) from e

    # 4. 注册 pending
    q: Queue = Queue(maxsize=1)
    with _PENDING_LOCK:
        _PENDING[call_id] = q

    # 5. 写帧到 stdout
    _write_frame(frame)

    # 6. 阻塞等响应
    try:
        response = q.get()
    except Exception as e:
        with _PENDING_LOCK:
            _PENDING.pop(call_id, None)
        raise CapabilityConnectionError(f"等待响应异常: {e}") from e

    # 7. 处理响应
    with _PENDING_LOCK:
        _PENDING.pop(call_id, None)
    return _handle_response(response)


def _handle_response(frame: dict) -> Any:
    """处理 result/error 帧，返回解码值或抛对应异常。"""
    if frame.get("type") == "_shutdown":
        raise CapabilityConnectionError("evaluator 通道已关闭 / IPC 断开")

    if frame.get("type") == "error":
        code = frame.get("code", "SystemError")
        message = frame.get("message", "")
        if code == "NotFound":
            raise CapabilityNotFoundError(message)
        if code == "Rejected":
            raise CapabilityRejectedError(message)
        # Exception / SystemError 等
        trace = frame.get("trace", "")
        exc = CapabilityError(message, code=code, trace=trace)
        if trace:
            exc.trace = trace
        raise exc

    # type == 'result'
    value = frame.get("value")
    return decode_value(value)


def _reset_pending_for_tests() -> None:
    """清空 pending（仅测试用）。"""
    with _PENDING_LOCK:
        _PENDING.clear()
