"""
noj_solution_sdk —— 不可信 Solution 端 SDK

由用户提交的 solution.py 导入，提供：
- `register(fn)` / `register(name, fn)`：把函数暴露给 Evaluator 调用
- `call_capability(name, *args)`：调用 Evaluator 注册的能力（如受限网络请求）

启动入口（host 模块）：
    python3 -m noj_solution_sdk.host --entry solution.py

host 读取 stdin NDJSON 帧，调用注册的函数，写回 stdout 响应帧。
"""

from .registry import (
    FunctionAlreadyRegisteredError,
    NotRegisteredError,
    get_registry,
    register,
)
from .capability import (
    CapabilityConnectionError,
    CapabilityError,
    CapabilityNotFoundError,
    CapabilityRejectedError,
    call_capability,
)

__all__ = [
    "register",
    "call_capability",
    "FunctionAlreadyRegisteredError",
    "NotRegisteredError",
    "CapabilityNotFoundError",
    "CapabilityRejectedError",
    "CapabilityConnectionError",
    "CapabilityError",
]
