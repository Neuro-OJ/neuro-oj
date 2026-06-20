#!/usr/bin/env python3
"""A+B Problem 评测脚本"""

import sys
import os

# 从环境变量读取测试数据（由 noj-judge 注入）
TEST_INPUT = os.environ.get("TEST_INPUT", "1 2")
EXPECTED_OUTPUT = os.environ.get("EXPECTED_OUTPUT", "3")


def main():
    try:
        # 读取用户程序输出（只读一次）
        user_output = sys.stdin.read().strip()

        # 解析测试输入
        parts = TEST_INPUT.split()
        if len(parts) != 2:
            print("Wrong Answer: Invalid test input", file=sys.stderr)
            sys.exit(1)

        a = int(parts[0])
        b = int(parts[1])
        expected = str(a + b)

        if user_output == expected:
            print("Accepted", file=sys.stderr)
            sys.exit(0)
        else:
            print("Wrong Answer", file=sys.stderr)
            print(f"Expected: {expected}", file=sys.stderr)
            print(f"Got: {user_output}", file=sys.stderr)
            sys.exit(1)
    except Exception as e:
        print(f"Runtime Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()