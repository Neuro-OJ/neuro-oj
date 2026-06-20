#!/usr/bin/env python3
"""
Hello World 评测脚本
"""

import sys

EXPECTED_OUTPUT = "Hello, World!\n"


def main():
    try:
        user_output = sys.stdin.read()
        if user_output == EXPECTED_OUTPUT:
            print("Accepted", file=sys.stderr)
            sys.exit(0)
        else:
            print("Wrong Answer", file=sys.stderr)
            sys.exit(1)
    except Exception as e:
        print(f"Runtime Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()