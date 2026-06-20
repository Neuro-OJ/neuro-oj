#!/usr/bin/env python3
"""A+B Problem 评测脚本"""

import sys


def main():
    try:
        input_data = sys.stdin.read().strip()
        if not input_data:
            print("Wrong Answer: Empty input", file=sys.stderr)
            sys.exit(1)

        parts = input_data.split()
        if len(parts) != 2:
            print("Wrong Answer: Expected 2 numbers", file=sys.stderr)
            sys.exit(1)

        a = int(parts[0])
        b = int(parts[1])
        expected = a + b

        user_output = sys.stdin.read().strip()
        if user_output == str(expected):
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