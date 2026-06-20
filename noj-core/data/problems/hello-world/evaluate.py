#!/usr/bin/env python3
"""
Hello World 评测脚本

读取用户输出，与预期输出进行比较。
"""

import sys

EXPECTED_OUTPUT = "Hello, World!\n"


def main():
    try:
        # 读取用户程序输出
        user_output = sys.stdin.read()

        # 比较输出
        if user_output == EXPECTED_OUTPUT:
            print("Accepted", file=sys.stderr)
            sys.exit(0)
        else:
            print(f"Wrong Answer", file=sys.stderr)
            print(f"Expected: {repr(EXPECTED_OUTPUT)}", file=sys.stderr)
            print(f"Got: {repr(user_output)}", file=sys.stderr)
            sys.exit(1)
    except Exception as e:
        print(f"Runtime Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()