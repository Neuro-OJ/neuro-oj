#!/usr/bin/env python3
"""
T0-LMCC 评测脚本：A+B Problem

评分（总分 10）：
- 内容正确 8 分：每通过一个测试点得 0.4 分
- 格式正确 2 分：所有输出均为整数格式
"""

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

# 路径配置
DATA_DIR = Path(__file__).parent
VISIBLE_DATA = DATA_DIR / "visible.jsonl"
HIDDEN_DATA = DATA_DIR / "hidden.jsonl"
CODE_PATH = Path("/tmp/main.py")

# 评分配置
CONTENT_SCORE_FULL = 8.0
FORMAT_SCORE_FULL = 2.0
FULL_SCORE = CONTENT_SCORE_FULL + FORMAT_SCORE_FULL

# 超时（秒）
TIMEOUT = 5


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


def run_submission(input_str: str) -> tuple[str, str]:
    """运行用户代码，返回 (stdout, stderr)"""
    if not CODE_PATH.exists():
        raise FileNotFoundError(f"代码文件不存在: {CODE_PATH}")

    result = subprocess.run(
        ["python3", str(CODE_PATH)],
        input=input_str,
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
    )
    return result.stdout.strip(), result.stderr.strip()


def eval_split(split_name: str, data: list[dict]) -> dict[str, Any]:
    """评测一个数据集"""
    passed = 0
    total = len(data)
    all_valid_int = True
    case_results = []

    for item in data:
        try:
            stdout, stderr = run_submission(item["input"])
        except subprocess.TimeoutExpired:
            stdout, stderr = "", "TIMEOUT"

        output_line = stdout.strip().splitlines()[-1] if stdout.strip() else ""
        expected = str(item["expected"]).strip()

        # 检查输出是否为有效整数
        is_valid = False
        try:
            int(output_line)
            is_valid = True
        except ValueError:
            all_valid_int = False

        # 内容匹配
        content_ok = output_line == expected
        if content_ok:
            passed += 1

        case_results.append({
            "id": item["id"],
            "input": item["input"],
            "expected": expected,
            "actual": output_line,
            "content_ok": content_ok,
            "stderr": stderr if stderr else None,
        })

        status = "PASS" if content_ok else "FAIL"
        print(f"[{split_name}] {item['id']}: {status}")
        print(f"  输入: {repr(item['input'])}")
        print(f"  期望: {expected}")
        print(f"  输出: {output_line}")

    return {
        "passed": passed,
        "total": total,
        "all_valid_int": all_valid_int,
        "cases": case_results,
    }


def main() -> None:
    visible_data = load_jsonl(VISIBLE_DATA)
    hidden_data = load_jsonl(HIDDEN_DATA)
    hidden_missing = len(hidden_data) == 0

    print("=" * 48)
    print("T0-LMCC 评测开始：A+B Problem")
    print("=" * 48)

    visible_stat = eval_split("VISIBLE", visible_data)

    if hidden_missing:
        print("\n⚠️ 隐藏数据未提供")
        hidden_stat = {
            "passed": 0, "total": 0, "all_valid_int": True, "cases": [],
        }
    else:
        hidden_stat = eval_split("HIDDEN", hidden_data)

    total_passed = visible_stat["passed"] + hidden_stat["passed"]
    total_cases = visible_stat["total"] + hidden_stat["total"]
    format_ok = visible_stat["all_valid_int"] and hidden_stat["all_valid_int"]

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


if __name__ == "__main__":
    main()
