#!/usr/bin/env python3
"""
A+B Problem 评测脚本

读取输入文件，计算 a+b，并与用户输出比较。
"""

import sys


def main():
    try:
        # 读取输入
        input_data = sys.stdin.read().strip()
        if not input_data:
            print("Wrong Answer: Empty input", file=sys.stderr)
            sys.exit(1)

        # 解析输入
        parts = input_data.split()
        if len(parts) != 2:
            print(f"Wrong Answer: Expected 2 numbers, got {len(parts)}", file=sys.stderr)
            sys.exit(1)

        a = int(parts[0])
        b = int(parts[1])
        expected = a + b

        # 读取用户输出
        user_output = sys.stdin.read().strip()

        # 比较输出
        if user_output == str(expected):
            print("Accepted", file=sys.stderr)
            sys.exit(0)
        else:
            print(f"Wrong Answer", file=sys.stderr)
            print(f"Expected: {expected}", file=sys.stderr)
            print(f"Got: {user_output}", file=sys.stderr)
            sys.exit(1)
    except Exception as e:
        print(f"Runtime Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()