#!/usr/bin/env python3
"""
T0-LMCC：A+B Problem — 参考实现（双容器版）

输入：一行两个整数，空格分隔
输出：它们的和
"""

def solve(input_str: str) -> str:
    """入口函数：由 noj_solution_sdk.host 调用"""
    line = input_str.strip()
    if not line:
        return "0"
    a, b = map(int, line.split())
    return str(a + b)
