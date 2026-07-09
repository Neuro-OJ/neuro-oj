"""
noj_evaluator_sdk result 模块。

`result.accept(score)` / `result.wrong_answer(score, message)` 把最终结果写入 stdout
（格式：`---RESULT---` + JSON），judge 在 evaluator exec 的 stdout 上解析该标记。

调用后进程**应立即退出**——不再有后续 SDK 调用，否则标记会被后续 NDJSON 帧污染。
"""

from __future__ import annotations

import json
import sys
from typing import Any, Optional


class Result:
    """最终结果写入器。

    每个 evaluate.py 流程中**只应调用一次**：
        from noj_evaluator_sdk import result
        result.accept(score=100)
    """

    def __init__(self) -> None:
        self._written = False

    def _write(self, status: str, score: float, **kwargs: Any) -> None:
        if self._written:
            raise RuntimeError("result 已被写入一次，禁止重复")
        self._written = True
        payload = {
            "status": status,
            "score": int(round(score * 100)),  # ×100 整数值，与 core 对齐
            "details": kwargs.get("details", {}),
        }
        if "message" in kwargs:
            payload["details"]["message"] = kwargs["message"]
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write(f"---RESULT---\n{line}\n")
        sys.stdout.flush()

    def accept(self, score: float = 100.0, **kwargs: Any) -> None:
        """评测通过。默认 score=100。"""
        self._write("Accepted", score, **kwargs)

    def wrong_answer(
        self,
        score: float = 0.0,
        message: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        """答案错误。message 进入 details.message。"""
        if message is not None:
            kwargs["message"] = message
        self._write("WrongAnswer", score, **kwargs)

    def runtime_error(self, message: str, **kwargs: Any) -> None:
        """评测脚本自身出错（非用户代码问题）。"""
        kwargs["message"] = message
        self._write("RuntimeError", 0.0, **kwargs)

    def system_error(self, message: str, **kwargs: Any) -> None:
        """系统错误（支持包解压失败、RPC 通道异常等）。"""
        kwargs["message"] = message
        self._write("SystemError", 0.0, **kwargs)