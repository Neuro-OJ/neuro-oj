#!/usr/bin/env python3
"""
T0-LMCC：传感器数据滤波 — 参考实现（双容器版）

输入格式：
- 第一行：n 和 k（空格分隔）
- 第二行：n 个整数，即 sensor_data

输出：n-k+1 个浮点数（保留两位小数），空格分隔
"""


def sliding_window_average(n: int, k: int, data: list[int]) -> list[str]:
    """滑动窗口平均"""
    result = []
    for i in range(n - k + 1):
        avg = sum(data[i:i + k]) / k
        result.append(f"{avg:.2f}")
    return result


def solve(input_str: str) -> str:
    """入口函数：由 noj_solution_sdk.host 调用"""
    lines = input_str.strip().split("\n")
    n, k = map(int, lines[0].split())
    data = list(map(int, lines[1].split()))
    result = sliding_window_average(n, k, data)
    return " ".join(result)
