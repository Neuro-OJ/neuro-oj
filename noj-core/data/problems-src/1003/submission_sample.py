# -*- coding: utf-8 -*-
"""
T0-LMCC 示例提交：星港舱门报码归一化（双容器版）

你需要实现 solve 函数，接收原始文本 report 描述，返回标准化 JSON 字符串。
"""

import json
import re
from typing import Any


# 中文数字到阿拉伯数字映射
CN_NUM = {
    "一": "01", "二": "02", "三": "03", "四": "04",
    "五": "05", "六": "06", "七": "07", "八": "08",
    "九": "09", "十": "10", "十一": "11", "十二": "12",
}

# 区域映射
AREA_MAP = {
    "东环": "E", "东区": "E", "东侧": "E", "东": "E",
    "西环": "W", "西区": "W", "西侧": "W", "西": "W",
    "北环": "N", "北区": "N", "北侧": "N", "北": "N",
    "南环": "S", "南区": "S", "南侧": "S", "南": "S",
    "主环": "I", "内环": "I", "内侧": "I", "主": "I", "内": "I",
    "外环": "O", "外侧": "O", "外": "O",
}

# 状态关键词
FAULT_KEYWORDS = ["故障", "打不开", "拉不开", "失灵", "卡住", "异常", "坏了", "拉不开"]
CLOSED_KEYWORDS = ["关闭", "封闭", "锁住", "关着", "暂停通行", "封闭"]
OPEN_KEYWORDS = ["开启", "打开", "恢复通行", "放行", "通了", "重新打开", "已开启", "放行"]


def normalize_gate_report(text: str) -> dict[str, str]:
    """归一化舱门报码"""
    text = text.lower()

    # 提取区域
    area = None
    for kw, letter in AREA_MAP.items():
        if kw in text:
            area = letter
            break

    # 提取编号
    gate_num = None
    for cn, num in CN_NUM.items():
        if cn in text:
            gate_num = num
            break

    # 阿拉伯数字
    match = re.search(r"(\d+)号门", text)
    if match:
        num = int(match.group(1))
        gate_num = f"{num:02d}"

    # 确定状态（优先级：fault > closed > open）
    status = "open"  # 默认
    if any(kw in text for kw in FAULT_KEYWORDS):
        status = "fault"
    elif any(kw in text for kw in CLOSED_KEYWORDS):
        status = "closed"
    elif any(kw in text for kw in OPEN_KEYWORDS):
        status = "open"

    gate_id = f"{area}-{gate_num}" if area and gate_num else ""

    return {"gate_id": gate_id, "status": status}


def solve(report: str) -> str:
    """入口函数：由 noj_solution_sdk.host 调用"""
    result = normalize_gate_report(report)
    return json.dumps(result, ensure_ascii=False)
