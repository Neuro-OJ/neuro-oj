#!/usr/bin/env python3
"""
E2E 测试用评测脚本（evaluate.py）

从 stdin 读取用户代码输出，与预期输出逐行比对。
通过 ---RESULT--- 标记输出评测结果 JSON。

支持三种模式（由 visible.jsonl 中的 mode 字段控制）：
  - normal: 正常比对（用于 Accepted / WA 测试）
  - tle: 触发超时（用于 TLE 测试，无限循环等待）

用法（由 noj-judge 在容器中调用）：
  python3 /tmp/evaluate.py < /tmp/submission_output.txt
"""

import json
import sys
import os


def load_test_cases():
    """加载可见测试用例"""
    cases = []
    visible_path = "/tmp/visible.jsonl"
    if os.path.exists(visible_path):
        with open(visible_path) as f:
            for line in f:
                line = line.strip()
                if line:
                    cases.append(json.loads(line))
    return cases


def compare_output(expected: str, actual: str) -> bool:
    """逐行比较预期输出和实际输出（忽略首尾空白）"""
    expected_lines = expected.strip().split("\n")
    actual_lines = actual.strip().split("\n")
    if len(expected_lines) != len(actual_lines):
        return False
    return all(
        e.strip() == a.strip()
        for e, a in zip(expected_lines, actual_lines)
    )


def main():
    cases = load_test_cases()
    if not cases:
        # 没有测试用例：直接输出结果
        result = {
            "status": "Accepted",
            "score": 1000,
            "details": {"message": "no test cases, default pass"},
        }
        print("---RESULT---")
        print(json.dumps(result))
        return

    # 读取用户代码输出（stdin 或文件）
    user_output = sys.stdin.read()

    max_score = 1000
    score_per_case = max_score // len(cases)
    total_score = 0
    passed = 0
    failed_cases = []

    for i, case in enumerate(cases):
        mode = case.get("mode", "normal")
        expected = case.get("expected", "")

        if mode == "tle":
            # TLE 模式：如果评测走到了这里，说明超时 kill 后返回了部分输出
            # 直接标记为 Time Limit Exceeded
            result = {
                "status": "TimeLimitExceeded",
                "score": 0,
                "details": {
                    "message": "Code execution timed out",
                    "cases": [{"id": i, "status": "TimeLimitExceeded"}],
                },
            }
            print("---RESULT---")
            print(json.dumps(result))
            return

        if compare_output(expected, user_output):
            total_score += score_per_case
            passed += 1
        else:
            failed_cases.append({
                "id": i,
                "expected": expected,
                "actual": user_output if len(cases) == 1 else "(see full output)",
            })

    # 判定最终结果
    if passed == len(cases):
        status = "Accepted"
        score = max_score
    elif failed_cases:
        status = "WrongAnswer"
        score = total_score
    else:
        status = "SystemError"
        score = 0

    result = {
        "status": status,
        "score": score,
        "details": {
            "passed": passed,
            "total": len(cases),
            "failed_cases": failed_cases,
        },
    }

    print("---RESULT---")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
