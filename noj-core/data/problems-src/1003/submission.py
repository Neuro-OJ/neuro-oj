#!/usr/bin/env python3
"""
T0-LMCC：A+B Problem — 参考实现

输入：一行两个整数，空格分隔
输出：它们的和
"""

import sys


def main() -> None:
    line = sys.stdin.read().strip()
    if not line:
        return
    a, b = map(int, line.split())
    print(a + b)


if __name__ == "__main__":
    main()
