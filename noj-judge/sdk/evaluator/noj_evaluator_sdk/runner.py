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


# ── 选手缺函数 → 0 分 ────────────────────────────────────
#
# 选手没有定义题面要求的函数（host 回 NotFound）是确定的选手侧结果，应判 0 分；
# 但大量既有 evaluate.py 不捕获 NotFoundError（或捕获后原样 raise），进程以未捕获
# 异常退出、不输出 `---RESULT---`，judge 只能归为平台错误（platform_error）。
# 这里通过 sys.excepthook 在**未捕获**时兜底写出 0 分结果：evaluate.py 自行捕获
# NotFoundError 的逻辑完全不受影响，且无需修改任何题目脚本。
#
# 只认 host 明确标注 `reason=not_registered` 的 NotFound：entry 加载失败（语法
# 错误/导入失败）时注册表为空，同样回 NotFound，但那不是"缺函数"，保持平台错误；
# 旧版 solution 镜像不带 reason，同样回退旧行为（混跑安全）。

MISSING_FUNCTION_REASON = "not_registered"

_HOOK_INSTALLED = False


def _install_missing_function_hook() -> None:
    """幂等安装 excepthook（链式调用原 hook，traceback 仍写 stderr）。"""
    global _HOOK_INSTALLED
    if _HOOK_INSTALLED:
        return
    _HOOK_INSTALLED = True
    previous = sys.excepthook

    def _hook(exc_type, exc, tb):  # type: ignore[no-untyped-def]
        try:
            if (
                isinstance(exc, NotFoundError)
                and exc.fn
                and exc.reason == MISSING_FUNCTION_REASON
            ):
                _write_missing_function_result(exc.fn)
        except Exception as e:  # 兜底逻辑自身失败不得吞掉原异常
            sys.stderr.write(f"[noj_evaluator_sdk] 写出缺函数结果失败: {e}\n")
        previous(exc_type, exc, tb)

    sys.excepthook = _hook


def _write_missing_function_result(fn: str) -> bool:
    """写出 0 分 `---RESULT---`；result 已写过时不重复写，返回是否写出。"""
    from .result import Result

    pkg = sys.modules.get(__package__ or "")
    shared = getattr(pkg, "result", None)
    writer = shared if isinstance(shared, Result) else Result()
    if writer._written:
        return False
    message = f"未定义函数 {fn}"
    writer.wrong_answer(
        score=0,
        message=message,
        details={"error_code": "function_not_found", "function": fn},
    )
    sys.stderr.write(
        f"[noj_evaluator_sdk] 选手未定义函数 {fn!r}，已按 0 分输出结果\n"
    )
    sys.stderr.flush()
    return True


class SolutionRunner:
    """阻塞式 Solution host 调用器。

    生命周期与 evaluate.py 进程一致。单实例即可复用。
    """

    def __init__(self, missing_function_as_zero: bool = True) -> None:
        """`missing_function_as_zero`：选手未定义被调用函数（`NotFoundError`）且
        evaluate.py 未捕获时，是否由 SDK 写出 0 分结果（默认开启）。关闭后恢复旧
        行为：进程异常退出、无 `---RESULT---`，judge 判为平台错误。
        """
        if missing_function_as_zero:
            _install_missing_function_hook()
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

        # 3. 注册 pending。若通道已断开，register_pending 直接返回预置哨兵帧的队列。
        q = self._rpc.register_pending(call_id)

        # 4. 写帧到 stdout。已关闭时跳过写（避免往断开的通道写帧），交由下方
        #    q.get() 取到哨兵帧、按约定抛 ConnectionError。
        if not self._closed:
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
        return self._handle_response(response, fn)

    def close(self) -> None:
        """主动关闭 runner（通常不需要，进程结束自动清理）。"""
        self._closed = True
        self._rpc.close()

    # ── 内部 ────────────────────────────────────────────

    def _reader_loop(self) -> None:
        """后台线程：从 stdin 持续读 NDJSON 帧，分发到对应 pending queue。

        无论**正常 EOF**（host 退出 / stdin 被关闭时，`for line in sys.stdin`
        迭代静默结束、并不抛 EOFError）、reader 异常，还是收到 `shutdown` 帧，
        退出时都统一标记关闭并唤醒所有 pending——否则 `call()` 会永久阻塞在
        `q.get()`（见 issue #680）。
        """
        try:
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
                        # host 主动关闭：停止读取，finally 统一唤醒 pending
                        break
                    # 其它 type 忽略
            except (EOFError, BrokenPipeError):
                # stdin 断开（个别 iterator 可能在 EOF 前才抛）：finally 统一收尾
                pass
            except Exception as e:
                sys.stderr.write(f"[noj_evaluator_sdk] reader_loop 异常: {e}\n")
                sys.stderr.flush()
        finally:
            # 覆盖正常 EOF、reader 异常与 shutdown 帧：置位关闭标志并唤醒所有
            # pending，确保 call() 立即抛 ConnectionError 而非永久阻塞（#680）。
            self._closed = True
            self._rpc.shutdown_pending()

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

    def _handle_response(self, frame: dict, fn: Optional[str] = None) -> Any:
        """处理 result/error 帧，抛出对应异常或返回值。"""
        if frame.get("type") == "_shutdown":
            raise ConnectionError("Solution host 已关闭 / IPC 通道断开")

        if frame.get("type") == "error":
            code = frame.get("code", "SystemError")
            message = frame.get("message", "")
            if code == "CallTimeout":
                raise SolutionTimeoutError(message)
            if code == "NotFound":
                raise NotFoundError(message, fn=fn, reason=frame.get("reason"))
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
