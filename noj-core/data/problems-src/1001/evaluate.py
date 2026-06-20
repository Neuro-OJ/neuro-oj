# -*- coding: utf-8 -*-
"""
T0-LMCC 评测脚本：星港舱门报码归一化

评分（总分 10）：
- 内容正确 8 分：按字段级准确率计分
- 格式正确 2 分：按格式命中率计分
"""

import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

# 路径配置
DATA_DIR = Path(__file__).parent
VISIBLE_DATA = DATA_DIR / "visible.jsonl"
HIDDEN_DATA = DATA_DIR / "hidden.jsonl"
CODE_PATH = Path("/tmp/submission.py")

# 评分配置
CONTENT_SCORE_FULL = 8.0
FORMAT_SCORE_FULL = 2.0
FULL_SCORE = CONTENT_SCORE_FULL + FORMAT_SCORE_FULL

# 格式校验
GATE_PATTERN = re.compile(r"^(E|W|N|S|I|O)-(\d{2})$")
ALLOWED_STATUS = {"open", "closed", "fault"}


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    """加载测试数据"""
    rows = []
    if not path.exists():
        return rows
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def gate_id_valid(gate_id: str) -> bool:
    """校验 gate_id 是否符合 X-YY 格式，且编号在 01-12"""
    match = GATE_PATTERN.fullmatch(str(gate_id))
    if not match:
        return False
    return 1 <= int(match.group(2)) <= 12


def parse_prediction(pred_text: str) -> tuple[dict | None, bool]:
    """解析模型输出，返回 (解析结果, 格式是否正确)"""
    try:
        obj = json.loads(pred_text)
    except Exception:
        return None, False

    if not isinstance(obj, dict):
        return None, False

    # 格式分：必须恰好两个键
    if set(obj.keys()) != {"gate_id", "status"}:
        return obj, False

    fmt_ok = gate_id_valid(obj.get("gate_id", "")) and obj.get("status") in ALLOWED_STATUS
    return obj, fmt_ok


def run_submission(text: str) -> tuple[str, dict | None, bool]:
    """运行用户代码，返回 (原始输出, 解析结果, 格式是否正确)"""
    if not CODE_PATH.exists():
        raise FileNotFoundError(f"代码文件不存在: {CODE_PATH}")

    # 运行用户代码，传入输入文本
    result = subprocess.run(
        ["python3", str(CODE_PATH), text],
        capture_output=True,
        text=True,
        timeout=10,
    )

    # 提取最后一行 JSON
    lines = [x.strip() for x in result.stdout.splitlines() if x.strip()]
    json_line = ""
    for line in reversed(lines):
        if line.startswith("{"):
            json_line = line
            break

    if not json_line:
        return result.stdout, None, False

    obj, fmt_ok = parse_prediction(json_line)
    return result.stdout, obj, fmt_ok


def eval_split(split_name: str, data: list[dict]) -> dict[str, Any]:
    """评测一个数据集"""
    field_correct = 0
    format_correct = 0
    total_fields = len(data) * 2
    case_results = []

    for item in data:
        raw_output, pred_obj, fmt_ok = run_submission(item["text"])

        # 字段级匹配
        hit_gate = pred_obj and pred_obj.get("gate_id") == item["expected_gate_id"]
        hit_status = pred_obj and pred_obj.get("status") == item["expected_status"]

        field_correct += int(hit_gate) + int(hit_status)
        format_correct += int(fmt_ok)

        case_results.append({
            "id": item["id"],
            "expected_gate_id": item["expected_gate_id"],
            "actual_gate_id": pred_obj.get("gate_id") if pred_obj else None,
            "expected_status": item["expected_status"],
            "actual_status": pred_obj.get("status") if pred_obj else None,
            "format_ok": fmt_ok,
        })

        print(f"[{split_name}] {item['id']}")
        print(f"  输入: {item['text']}")
        print(f"  输出: {raw_output.strip()}")
        print(f"  命中: gate_id={hit_gate}, status={hit_status}, format={fmt_ok}")

    return {
        "field_correct": field_correct,
        "total_fields": total_fields,
        "format_correct": format_correct,
        "total_cases": len(data),
        "cases": case_results,
    }


def main() -> None:
    visible_data = load_jsonl(VISIBLE_DATA)
    hidden_data = load_jsonl(HIDDEN_DATA)
    hidden_missing = len(hidden_data) == 0

    print("=" * 48)
    print("T0-LMCC 评测开始：星港舱门报码归一化")
    print("=" * 48)

    # 评测可见集
    visible_stat = eval_split("VISIBLE", visible_data)

    if hidden_missing:
        print("\n⚠️ 隐藏数据未提供")
        hidden_stat = {
            "field_correct": 0,
            "total_fields": 0,
            "format_correct": 0,
            "total_cases": 0,
            "cases": [],
        }
    else:
        hidden_stat = eval_split("HIDDEN", hidden_data)

    # 计算分数
    field_correct = visible_stat["field_correct"] + hidden_stat["field_correct"]
    total_fields = visible_stat["total_fields"] + hidden_stat["total_fields"]
    format_correct = visible_stat["format_correct"] + hidden_stat["format_correct"]
    total_cases = visible_stat["total_cases"] + hidden_stat["total_cases"]

    score_content = CONTENT_SCORE_FULL * field_correct / max(1, total_fields)
    score_format = FORMAT_SCORE_FULL * format_correct / max(1, total_cases)
    total_score = score_content + score_format

    print("\n" + "-" * 48)
    print(f"可见字段: {visible_stat['field_correct']}/{visible_stat['total_fields']}")
    print(f"隐藏字段: {hidden_stat['field_correct']}/{hidden_stat['total_fields']}")
    print(f"总字段命中: {field_correct}/{total_fields} -> {score_content:.2f}/{CONTENT_SCORE_FULL}")
    print(f"总格式命中: {format_correct}/{total_cases} -> {score_format:.2f}/{FORMAT_SCORE_FULL}")
    print(f"总分: {total_score:.2f}/{FULL_SCORE}")

    if hidden_missing:
        print("说明: 当前分数仅基于公开数据")

    # 输出结果
    result = {
        "status": "Accepted" if total_score == FULL_SCORE else "WrongAnswer",
        "score": int(total_score * 100),  # 转换为整数
        "details": {
            "score_content": round(score_content, 2),
            "score_format": round(score_format, 2),
            "visible": visible_stat,
            "hidden": hidden_stat,
            "hidden_provided": not hidden_missing,
        },
    }

    print("---RESULT---")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()