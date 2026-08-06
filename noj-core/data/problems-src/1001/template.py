# -*- coding: utf-8 -*-
"""
T0-LMCC：星港舱门报码归一化（starter code）

你需要实现 solve 函数：
  - 输入：report 字符串（舱门报码原始描述）
  - 输出：JSON 字符串，格式为 {"gate_id": "X-YY", "status": "open|closed|fault"}

可参考的提示：
  - 用正则提取"X号门"或"X号楼"的阿拉伯数字编号
  - 区域关键词（东/西/南/北/主/外 等）映射到单字母
  - 状态优先级：故障 > 关闭 > 开启
"""


def solve(report: str) -> str:
    """入口函数：由 noj_solution_sdk.host 调用"""
    # TODO: 在此实现题目要求的归一化逻辑
    raise NotImplementedError("请实现 solve 函数")
