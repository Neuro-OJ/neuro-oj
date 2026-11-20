#!/usr/bin/env python3
"""评测入口（代码题 · 双容器函数调用）。

协议契约（noj-docs/docs/standards/test-data.md）：
- 运行在 Evaluator 容器，通过 SolutionRunner 调用 Solution 容器里选手的 solve()；
- 结果由 SDK 的 result.accept() 写出（`---RESULT---` + JSON），分数刻度 0–100；
- details.cases[] 每项含 case_id / status / 布尔 hidden；
  隐藏用例**不得**输出 input / expected / actual。

评分：正式分数**只来自隐藏用例**（等权）；可见用例参与评测但不计分，仅供调试。

异常分两类，处理方式不同：
- **选手的问题**（solve 抛异常、超时、返回不可序列化对象、缺函数、进程崩溃）
  → 该用例判失败，继续评下一个，最终正常出分；
- **评测脚本自己的问题**（数据文件缺失、比较逻辑写错）→ 直接上抛，不输出结果，
  judge 记为平台错误，`noj-cli problem test` 会据此失败，避免「脚本坏了却出 0 分」。

诊断回显安全约束：选手输出一律经 echo() 压成单行再打印，防止在返回值里塞入
`---RESULT---` 行伪造分数。
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from noj_evaluator_sdk import ConnectionError as SolutionCrashedError
from noj_evaluator_sdk import NotFoundError
from noj_evaluator_sdk import RejectedError
from noj_evaluator_sdk import SolutionRunner
from noj_evaluator_sdk import SolutionTimeoutError
from noj_evaluator_sdk import SystemError as SolutionError
from noj_evaluator_sdk import configure_logging
from noj_evaluator_sdk import result

configure_logging()

DATA_DIR = Path(__file__).resolve().parent
VISIBLE_PATH = DATA_DIR / "visible.jsonl"
HIDDEN_PATH = DATA_DIR / "hidden.jsonl"

FULL_SCORE = 100.0
# 单次 solve 调用超时（毫秒）；与题面「数据范围与限制」保持一致。
CALL_TIMEOUT_MS = 2000
MAX_ECHO_CHARS = 300

# 选手侧错误：计为该用例失败，不中断评测。
USER_ERRORS = (
    SolutionTimeoutError,
    NotFoundError,
    RejectedError,
    SolutionCrashedError,
    SolutionError,
)


def echo(value: Any) -> str:
    """把任意值压成单行、限长，供诊断输出安全回显。"""
    flat = " ".join(str(value).split())
    if len(flat) > MAX_ECHO_CHARS:
        return flat[:MAX_ECHO_CHARS] + "…（已截断）"
    return flat


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def parse_output(raw: Any) -> Any:
    """选手返回 JSON 文本；取最后一个非空行解析，允许前面有调试输出。"""
    if not isinstance(raw, str):
        return None
    lines = [ln for ln in raw.splitlines() if ln.strip()]
    if not lines:
        return None
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError:
        return None


def run_case(runner: SolutionRunner, case: dict[str, Any], *, hidden: bool) -> dict[str, Any]:
    started = time.perf_counter()
    status = "WrongAnswer"
    raw: Any = None
    try:
        raw = runner.call("solve", case["input"], timeout_ms=CALL_TIMEOUT_MS)
        if parse_output(raw) == case["expected"]:
            status = "Accepted"
    except SolutionTimeoutError:
        status = "TimeLimitExceeded"
    except USER_ERRORS as exc:
        status = "RuntimeError"
        print(f"  [{case['id']}] 选手代码错误: {echo(type(exc).__name__)}")
    elapsed_ms = max(0, round((time.perf_counter() - started) * 1000))

    out: dict[str, Any] = {
        "case_id": case["id"],
        "status": status,
        "hidden": hidden,
        "visibility": "hidden" if hidden else "visible",
        "time_ms": elapsed_ms,
    }
    if not hidden:
        out.update(
            {
                "input": case["input"],
                "expected_output": json.dumps(case["expected"], ensure_ascii=False),
                "actual_output": echo(raw),
            }
        )
    # 不要给用例加 message / scored 等字段：平台按白名单裁剪 cases 的键，
    # 白名单外的键会被静默丢弃。整体说明请写 details.summary。
    return out


def main() -> None:
    visible = load_jsonl(VISIBLE_PATH)
    hidden = load_jsonl(HIDDEN_PATH)
    if not hidden:
        raise RuntimeError("hidden.jsonl 为空，无法评分")

    runner = SolutionRunner()
    cases: list[dict[str, Any]] = []
    for case in visible:
        cases.append(run_case(runner, case, hidden=False))
    passed = 0
    for case in hidden:
        r = run_case(runner, case, hidden=True)
        cases.append(r)
        passed += r["status"] == "Accepted"

    score = FULL_SCORE * passed / len(hidden)
    print(f"隐藏用例通过 {passed}/{len(hidden)}，得分 {score:.2f}")
    result.accept(
        score,
        details={
            "cases": cases,
            "summary": f"隐藏用例 {passed}/{len(hidden)} 通过；可见用例 {len(visible)} 条不计分",
        },
    )


if __name__ == "__main__":
    main()
