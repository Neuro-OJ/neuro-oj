"""
noj_evaluator_sdk —— 可信评测端 SDK

由 `evaluate.py` 导入，提供：
- `SolutionRunner`：阻塞调用 Solution 容器内的注册函数
- `result.accept(score, ...)` / `result.wrong_answer(...)`：写入 `---RESULT---` 标记
- `configure_logging()`：把所有 print/logging 重定向到 stderr，stdout 仅用于协议帧与 RESULT 标记

Evaluator ↔ judge 通信契约（详见 design.md §1）：
- stdout：NDJSON 帧（call 帧）+ `---RESULT---` 标记
- stdin：NDJSON 响应帧（result/error/log）
"""

from .errors import (
    ConnectionError,
    NotFoundError,
    RejectedError,
    SolutionTimeoutError,
    SystemError,
)
from .result import Result
from .runner import SolutionRunner
from .logging_config import configure_logging

# 公开 result 单例（`from noj_evaluator_sdk import result; result.accept(...)`）
result = Result()

__all__ = [
    "SolutionRunner",
    "result",
    "configure_logging",
    "ConnectionError",
    "NotFoundError",
    "RejectedError",
    "SolutionTimeoutError",
    "SystemError",
]