#!/usr/bin/env python3
"""Hello World 评测脚本"""

import sys
import os

# 从环境变量读取预期输出（由 noj-judge 注入）
EXPECTED_OUTPUT = os.environ.get("EXPECTED_OUTPUT", "Hello, World!\n")


def main():
    try:
        # 读取用户程序输出（只读一次）
        user_output = sys.stdin.read()

        if user_output == EXPECTED_OUTPUT:
            print("Accepted", file=sys.stderr)
            sys.exit(0)
        else:
            print("Wrong Answer", file=sys.stderr)
            print(f"Expected: {repr(EXPECTED_OUTPUT)}", file=sys.stderr)
            print(f"Got: {repr(user_output)}", file=sys.stderr)
            sys.exit(1)
    except Exception as e:
        print(f"Runtime Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()