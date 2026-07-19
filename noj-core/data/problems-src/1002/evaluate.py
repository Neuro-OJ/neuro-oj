#!/usr/bin/env python3
"""
T0-LMCC 评测脚本：传感器数据滤波（双容器版）

评分（总分 10）：
- 内容正确 8 分：每通过一个测试点得 0.8 分
- 格式正确 2 分：输出格式正确
"""

import json
from pathlib import Path
from typing import Any

from noj_evaluator_sdk.runner import SolutionRunner

# 路径配置
DATA_DIR = Path(__file__).parent
VISIBLE_DATA = DATA_DIR / "visible.jsonl"
HIDDEN_DATA = DATA_DIR / "hidden.jsonl"

# 评分配置
CONTENT_SCORE_FULL = 8.0
FORMAT_SCORE_FULL = 2.0
FULL_SCORE = CONTENT_SCORE_FULL + FORMAT_SCORE_FULL


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    """加载测试数据"""
    if not path.exists():
        return []
    rows = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def call_solution(runner: SolutionRunner, input_str: str) -> str:
    """通过 NDJSON 协议调用 Solution 容器中的用户代码"""
    result = runner.call("solve", input_str)
    return str(result)


def parse_float_list(s: str) -> list[float] | None:
    """解析空格分隔的浮点数列表"""
    try:
        parts = s.strip().split()
        return [float(x) for x in parts]
    except (ValueError, TypeError):
        return None


def eval_split(runner: SolutionRunner, split_name: str, data: list[dict]) -> dict[str, Any]:
    """评测一个数据集"""
    passed = 0
    total = len(data)
    all_format_ok = True
    case_results = []

    for item in data:
        try:
            output_line = call_solution(runner, item["input"])
        except Exception as e:
            output_line = ""
            print(f"  [!] Solution 调用异常: {e}")

        actual = output_line.strip()
        expected = str(item["expected"]).strip()

        # 解析浮点数列表
        actual_list = parse_float_list(actual)
        expected_list = parse_float_list(expected)

        # 格式检查：输出必须是有效的浮点数列表
        format_ok = actual_list is not None
        if not format_ok:
            all_format_ok = False

        # 内容匹配（每个元素允许 0.01 的误差）
        content_ok = False
        if actual_list is not None and expected_list is not None:
            if len(actual_list) == len(expected_list):
                content_ok = all(
                    abs(a - e) <= 0.015
                    for a, e in zip(actual_list, expected_list)
                )

        if content_ok:
            passed += 1

        case_results.append({
            "id": item["id"],
            "input": item["input"],
            "expected": expected,
            "actual": actual,
            "content_ok": content_ok,
            "format_ok": format_ok,
        })

        status = "PASS" if content_ok else "FAIL"
        print(f"[{split_name}] {item['id']}: {status}")
        print(f"  输入: {repr(item['input'])}")
        print(f"  期望: {expected}")
        print(f"  输出: {actual}")

    return {
        "passed": passed,
        "total": total,
        "format_ok": all_format_ok,
        "cases": case_results,
    }


def main() -> None:
    runner = SolutionRunner()

    visible_data = load_jsonl(VISIBLE_DATA)
    hidden_data = load_jsonl(HIDDEN_DATA)
    hidden_missing = len(hidden_data) == 0

    print("=" * 48)
    print("T0-LMCC 评测开始：传感器数据滤波（双容器版）")
    print("=" * 48)

    visible_stat = eval_split(runner, "VISIBLE", visible_data)

    if hidden_missing:
        print("\n⚠️ 隐藏数据未提供")
        hidden_stat = {
            "passed": 0, "total": 0, "format_ok": True, "cases": [],
        }
    else:
        hidden_stat = eval_split(runner, "HIDDEN", hidden_data)

    total_passed = visible_stat["passed"] + hidden_stat["passed"]
    total_cases = visible_stat["total"] + hidden_stat["total"]
    format_ok = visible_stat["format_ok"] and hidden_stat["format_ok"]

    score_content = CONTENT_SCORE_FULL * total_passed / max(1, total_cases)
    score_format = FORMAT_SCORE_FULL if format_ok else 0
    total_score = score_content + score_format

    print("\n" + "-" * 48)
    print(f"可见: {visible_stat['passed']}/{visible_stat['total']}")
    print(f"隐藏: {hidden_stat['passed']}/{hidden_stat['total']}")
    print(f"总计: {total_passed}/{total_cases} -> {score_content:.2f}/{CONTENT_SCORE_FULL}")
    print(f"格式: {'✅' if format_ok else '❌'} -> {score_format:.2f}/{FORMAT_SCORE_FULL}")
    print(f"总分: {total_score:.2f}/{FULL_SCORE}")

    if hidden_missing:
        print("说明: 当前分数仅基于公开数据")

    result = {
        "status": "Accepted" if total_score == FULL_SCORE else "WrongAnswer",
        "score": int(total_score * 100),
        "details": {
            "score_content": round(score_content, 2),
            "score_format": round(score_format, 2),
            "visible": visible_stat,
            "hidden": hidden_stat,
            "hidden_provided": not hidden_missing,
        },
    }

    print("---RESULT---")
    print(json.dumps(result, ensure_ascii=False))

    runner.close()


if __name__ == "__main__":
    main()
