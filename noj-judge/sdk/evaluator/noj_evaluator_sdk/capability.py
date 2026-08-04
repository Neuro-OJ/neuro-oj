"""
noj_evaluator_sdk capability 注册表。

evaluate.py 通过 `register_capability(name, handler)` 暴露可被 solution 调用的能力
（如受限网络请求）。handler 是普通 Python 函数，参数/返回值受与 `runner.call()`
相同的 RPC 类型契约约束（None / bool / int / float / str / bytes / list / dict）。

调用方向：solution 的 `call_capability(name, *args)` → judge 转发 →
evaluator runner reader 线程 → 查本注册表 → 同步执行 handler → 写响应帧。

安全模型：capability 是 evaluator（出题人）显式注册的；handler 内应做参数校验
（禁止通用 URL 转发等），参见出题人文档「如何提供受限网络能力」。
"""

from __future__ import annotations

import json
import sys
import threading
from typing import Any, Callable, Optional

_CAPABILITIES: dict[str, Callable] = {}
_LOCK = threading.RLock()
_OUT_LOCK = threading.Lock()


def register_capability(
    name: str, handler: Callable, timeout_ms: Optional[int] = None
) -> None:
    """注册 capability。

    重复注册同名时覆盖（最近注册生效）。

    `timeout_ms`：solution 调用该 capability 时的默认超时（毫秒）；
    None = judge 回退题目级 call_timeout_ms。注册时写一次性
    `cap_reg` 帧上报 judge（judge 侧私有协议，不转发给 solution）。
    """
    if not isinstance(name, str) or not name.strip():
        raise TypeError(f"capability 名称必须是非空字符串，实际 {type(name).__name__}")
    if not callable(handler):
        raise TypeError(f"handler 必须是 callable，实际 {type(handler).__name__}")
    if timeout_ms is not None and (
        not isinstance(timeout_ms, int) or timeout_ms <= 0
    ):
        raise ValueError(
            f"timeout_ms 必须是正整数或 None，实际 {timeout_ms!r}"
        )
    with _LOCK:
        _CAPABILITIES[name] = handler
    # 上报 judge（一次性 cap_reg 帧）
    frame = {"type": "cap_reg", "name": name}
    if timeout_ms is not None:
        frame["timeout_ms"] = timeout_ms
    line = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
    with _OUT_LOCK:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def _get_capability(name: str) -> Callable | None:
    """按名称取 handler（未注册返回 None）。"""
    with _LOCK:
        return _CAPABILITIES.get(name)


def _reset_capabilities_for_tests() -> None:
    """清空注册表（仅测试用）。"""
    with _LOCK:
        _CAPABILITIES.clear()
