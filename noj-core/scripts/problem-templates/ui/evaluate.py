#!/usr/bin/env python3
"""评测入口（界面题）：选手参数已被平台注入 template.py，这里逐条调用 classify()。

界面题后端与代码题完全一致：Solution 容器运行「注入参数 + template.py」生成的脚本，
本脚本通过 SolutionRunner 调用其中的函数。
评分：以营销短信为正类计算 F1 × 100；选手侧错误计为该条判错，评测脚本自身的问题上抛。
"""

from __future__ import annotations

import json
from pathlib import Path

from noj_evaluator_sdk import ConnectionError as SolutionCrashedError
from noj_evaluator_sdk import NotFoundError
from noj_evaluator_sdk import RejectedError
from noj_evaluator_sdk import SolutionRunner
from noj_evaluator_sdk import SolutionTimeoutError
from noj_evaluator_sdk import SystemError as SolutionError
from noj_evaluator_sdk import configure_logging
from noj_evaluator_sdk import f1_score
from noj_evaluator_sdk import result

configure_logging()

HIDDEN_PATH = Path(__file__).resolve().parent / "hidden.jsonl"
CALL_TIMEOUT_MS = 2000
USER_ERRORS = (
    SolutionTimeoutError,
    NotFoundError,
    RejectedError,
    SolutionCrashedError,
    SolutionError,
)


def main() -> None:
    with HIDDEN_PATH.open(encoding="utf-8") as fh:
        cases = [json.loads(line) for line in fh if line.strip()]
    if not cases:
        raise RuntimeError("hidden.jsonl 为空，无法评分")

    runner = SolutionRunner()
    preds: list[int] = []
    details = []
    for case in cases:
        try:
            pred = runner.call("classify", case["text"], timeout_ms=CALL_TIMEOUT_MS) is True
        except USER_ERRORS as exc:
            print(f"  [{case['id']}] 脚本出错: {type(exc).__name__}")
            pred = False
        preds.append(int(pred))
        details.append(
            {
                "case_id": case["id"],
                "status": "Accepted" if pred == case["spam"] else "WrongAnswer",
                "hidden": True,
                "visibility": "hidden",
            }
        )
    gold = [int(c["spam"]) for c in cases]
    score = 100.0 * f1_score(preds, gold)
    print(f"F1 = {score / 100:.4f}")
    result.accept(score, details={"cases": details, "summary": f"F1 = {score / 100:.4f}"})


if __name__ == "__main__":
    main()
