#!/usr/bin/env python3
"""评测入口（LLM 工程题）：选手构造提示词，评测脚本调用大模型并检查回复。

关键约定：
- 选手代码在 Solution 容器里**没有网络**，只返回提示词；大模型只由本脚本通过
  noj_evaluator_sdk.llm 调用，走平台网关并受 problem.json 的 llm 预算约束；
- 调用次数预算：每条留言 1 次 + SDK 对瞬时错误最多重试 1 次 → max_calls 至少为
  用例数 × 2（本模板 5 条用例，声明 12）；max_tokens 按提示词与回复长度估算；
- LLM 调用失败（网关不可用、额度耗尽）**不是选手的错**：直接上抛，judge 记为平台
  错误、不出分，避免把基础设施故障记成选手 0 分；
- 本地 `noj-cli problem test` 默认使用离线 mock（回显最后一条 user 消息），只能验证
  调用链路与预算；真实效果需 `--allow-network --llm-gateway <url> --llm-token <t>`。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from noj_evaluator_sdk import ConnectionError as SolutionCrashedError
from noj_evaluator_sdk import NotFoundError
from noj_evaluator_sdk import RejectedError
from noj_evaluator_sdk import SolutionRunner
from noj_evaluator_sdk import SolutionTimeoutError
from noj_evaluator_sdk import SystemError as SolutionError
from noj_evaluator_sdk import configure_logging
from noj_evaluator_sdk import llm
from noj_evaluator_sdk import result

configure_logging()

DATA_DIR = Path(__file__).resolve().parent
CALL_TIMEOUT_MS = 2000
MAX_PROMPT_CHARS = 2000
# 限制单次回复长度，控制 token 消耗。
MAX_REPLY_TOKENS = 64

USER_ERRORS = (
    SolutionTimeoutError,
    NotFoundError,
    RejectedError,
    SolutionCrashedError,
    SolutionError,
)


def load_jsonl(name: str) -> list[dict[str, Any]]:
    with (DATA_DIR / name).open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def build_prompt(runner: SolutionRunner, message: str) -> str | None:
    """调用选手代码；选手侧错误或返回值不合规时返回 None（该用例失败）。"""
    try:
        prompt = runner.call("build_prompt", message, timeout_ms=CALL_TIMEOUT_MS)
    except USER_ERRORS as exc:
        print(f"  build_prompt 出错: {type(exc).__name__}")
        return None
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT_CHARS:
        print("  build_prompt 返回值不合规（需为非空字符串且不超过 2000 字符）")
        return None
    return prompt


def ask_model(prompt: str) -> str:
    """调用大模型；LLMError 不捕获（平台问题，交给 judge 记为平台错误）。"""
    resp = llm.complete(
        messages=[{"role": "user", "content": prompt}],
        max_tokens=MAX_REPLY_TOKENS,
        temperature=0,
    )
    return str(resp["choices"][0]["message"]["content"] or "")


def run_case(runner: SolutionRunner, case: dict[str, Any], *, hidden: bool) -> dict[str, Any]:
    prompt = build_prompt(runner, case["message"])
    reply = ask_model(prompt) if prompt is not None else ""
    passed = prompt is not None and case["expected"] in reply
    out: dict[str, Any] = {
        "case_id": case["id"],
        "status": "Accepted" if passed else "WrongAnswer",
        "hidden": hidden,
        "visibility": "hidden" if hidden else "visible",
    }
    if not hidden:
        out.update(
            {
                "input": case["message"],
                "expected_output": case["expected"],
                "actual_output": " ".join(reply.split())[:300],
            }
        )
    return out


def main() -> None:
    visible = load_jsonl("visible.jsonl")
    hidden = load_jsonl("hidden.jsonl")
    if not hidden:
        raise RuntimeError("hidden.jsonl 为空，无法评分")

    runner = SolutionRunner()
    cases = [run_case(runner, c, hidden=False) for c in visible]
    passed = 0
    for c in hidden:
        r = run_case(runner, c, hidden=True)
        cases.append(r)
        passed += r["status"] == "Accepted"
    score = 100.0 * passed / len(hidden)
    print(f"隐藏用例通过 {passed}/{len(hidden)}，得分 {score:.2f}")
    result.accept(
        score,
        details={"cases": cases, "summary": f"隐藏留言 {passed}/{len(hidden)} 通过"},
    )


if __name__ == "__main__":
    main()
