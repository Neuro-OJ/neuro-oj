#!/usr/bin/env python3
"""评测入口（预测提交题）：读取选手上传的预测文件，与隐藏标签比较算准确率。

- 预测题没有 Solution 容器：选手文件由平台放在 /workspace/prediction/（只有一个文件），
  load_predictions() 自动定位；
- 隐藏标签 hidden_labels.csv 随支持包进入 Evaluator 容器，**不得**写进 details；
- 选手文件格式不对（ID 缺失/重复、缺少 value 列、编码错误）→ 0 分并说明原因；
  隐藏标签读不到等评测脚本自身的问题 → 上抛，judge 记为平台错误。
"""

from __future__ import annotations

import csv
from pathlib import Path

from noj_evaluator_sdk import assert_id_alignment
from noj_evaluator_sdk import configure_logging
from noj_evaluator_sdk import emit_case_scores
from noj_evaluator_sdk import load_predictions
from noj_evaluator_sdk import result

configure_logging()

LABELS_PATH = Path(__file__).resolve().parent / "hidden_labels.csv"


def load_gold() -> dict[str, str]:
    with LABELS_PATH.open(encoding="utf-8", newline="") as fh:
        gold = {row["id"]: row["label"] for row in csv.DictReader(fh)}
    if not gold:
        raise RuntimeError("hidden_labels.csv 为空，无法评分")
    return gold


def main() -> None:
    gold = load_gold()
    try:
        preds = load_predictions()
        if "value" not in preds.columns:
            raise ValueError(f"缺少 value 列（实际列：{preds.columns}）")
        assert_id_alignment(preds, list(gold.keys()))
    except (ValueError, UnicodeDecodeError) as exc:
        # 选手文件的问题：判 0 分，说明写进 summary（只含公开的 ID 信息）。
        print(f"预测文件不合法: {exc}")
        result.accept(0.0, details={"summary": f"预测文件不合法：{exc}"})
        return
    # 每个 case 自动带 hidden: true，标签内容不会写入 details。
    emit_case_scores(preds, gold, metric="accuracy")


if __name__ == "__main__":
    main()
