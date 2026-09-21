"""prediction 模式辅助：安全加载预测文件并做最小对齐校验。

安全约束：
- **禁止 pickle**：不调用任何反序列化器；``.npz`` / ``.npy`` 一律
  ``allow_pickle=False``。pickle 类扩展名直接拒绝。
- 文本格式（csv/tsv/jsonl/json/txt）拒绝首 4KB 含 NUL 字节的文件。
- 仅在 ``$NOJ_PREDICTION_DIR`` 下唯一存在一个文件时自动定位。
- 本模块的 import **不得依赖 numpy**（evaluator 基础镜像无 numpy）；
  只有 ``.npy`` / ``.npz`` 分支才惰性 import numpy。
- ``emit_case_scores`` 的每个 case 必带 ``hidden: true``，且**不得**把隐藏标签
  内容写进 ``details``。
"""

from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass
from typing import Any, Optional

_REJECTED_EXT = {".pkl", ".pickle", ".pt", ".pth", ".bin", ".joblib", ".ckpt"}
_TEXT_EXT = {".csv", ".tsv", ".jsonl", ".json", ".txt"}
_NUMPY_EXT = {".npy", ".npz"}


@dataclass
class PredictionBundle:
    path: str
    columns: list[str]
    rows: list[dict[str, Any]]

    @property
    def ids(self) -> list[str]:
        """返回 ``id`` 列（缺失时按行号）。"""
        if self.rows and "id" in self.rows[0]:
            return [str(r["id"]) for r in self.rows]
        return [str(i) for i in range(len(self.rows))]


def _locate(path: Optional[str]) -> str:
    if path:
        return path
    d = os.environ.get("NOJ_PREDICTION_DIR", "/workspace/prediction")
    if not os.path.isdir(d):
        raise FileNotFoundError(f"预测目录不存在: {d}")
    files = [f for f in os.listdir(d) if os.path.isfile(os.path.join(d, f))]
    if len(files) != 1:
        raise ValueError(f"预测目录应恰好包含 1 个文件，实际 {len(files)} 个: {files}")
    return os.path.join(d, files[0])


def _check_extension(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in _REJECTED_EXT:
        raise ValueError(f"禁止 pickle 类格式: {ext}")
    return ext


def load_predictions(path: Optional[str] = None) -> PredictionBundle:
    """安全加载预测文件，返回 :class:`PredictionBundle`。

    ``path`` 为空时从 ``$NOJ_PREDICTION_DIR``（默认 ``/workspace/prediction``）
    自动定位唯一文件。
    """
    p = _locate(path)
    ext = _check_extension(p)

    if ext in _TEXT_EXT:
        with open(p, "rb") as fh:
            if b"\x00" in fh.read(4096):
                raise ValueError("预测文件含 NUL 字节，疑似二进制/pickle")
        if ext == ".jsonl":
            with open(p, encoding="utf-8") as fh:
                rows = [json.loads(line) for line in fh if line.strip()]
        elif ext == ".json":
            with open(p, encoding="utf-8") as fh:
                data = json.load(fh)
            rows = data if isinstance(data, list) else [data]
        else:
            delim = "\t" if ext == ".tsv" else ","
            with open(p, encoding="utf-8", newline="") as fh:
                rows = [dict(r) for r in csv.DictReader(fh, delimiter=delim)]
        cols = list(rows[0].keys()) if rows else []
        return PredictionBundle(path=p, columns=cols, rows=rows)

    if ext in _NUMPY_EXT:
        try:
            import numpy as np  # noqa: PLC0415  —— 仅 numpy 格式需要；基础镜像可能缺失
        except ImportError as exc:
            raise RuntimeError("该预测格式需要 numpy，但评测镜像未安装") from exc
        if ext == ".npz":
            with np.load(p, allow_pickle=False) as npz:  # 硬编码 allow_pickle=False
                rows = []
                keys = list(npz.keys())
                arrays = [npz[k] for k in keys]
                n = len(arrays[0]) if arrays else 0
                for i in range(n):
                    rows.append({
                        k: a[i].item() if a[i].ndim == 0 else a[i].tolist()
                        for k, a in zip(keys, arrays)
                    })
                return PredictionBundle(path=p, columns=keys, rows=rows)
        arr = np.load(p, allow_pickle=False)
        rows = [
            {"value": arr[i].item() if arr[i].ndim == 0 else arr[i].tolist()}
            for i in range(len(arr))
        ]
        return PredictionBundle(path=p, columns=["value"], rows=rows)

    raise ValueError(f"不支持的预测格式: {ext or '(无扩展名)'}")


def assert_id_alignment(prediction: PredictionBundle, expected_ids: list[str]) -> None:
    """校验预测 ID 与隐藏标签 ID 完全一致（缺失/多余均报错）。"""
    got = set(prediction.ids)
    want = set(map(str, expected_ids))
    missing = want - got
    extra = got - want
    if missing or extra:
        raise ValueError(
            f"预测 ID 与期望不一致：缺少 {len(missing)} 个、多出 {len(extra)} 个"
        )


def accuracy(pred: list[Any], gold: list[Any]) -> float:
    """逐元素严格相等的分类准确率。"""
    if not gold:
        return 0.0
    return sum(1 for p, g in zip(pred, gold) if p == g) / len(gold)


def rmse(pred: list[float], gold: list[float]) -> float:
    """均方根误差。"""
    if not gold:
        return 0.0
    return (
        sum((float(p) - float(g)) ** 2 for p, g in zip(pred, gold)) / len(gold)
    ) ** 0.5


def mae(pred: list[float], gold: list[float]) -> float:
    """平均绝对误差。"""
    if not gold:
        return 0.0
    return sum(abs(float(p) - float(g)) for p, g in zip(pred, gold)) / len(gold)


def f1_score(pred: list[Any], gold: list[Any], positive: Any = 1) -> float:
    """二分类 F1（指定正类标签）。"""
    tp = sum(1 for p, g in zip(pred, gold) if p == positive and g == positive)
    fp = sum(1 for p, g in zip(pred, gold) if p == positive and g != positive)
    fn = sum(1 for p, g in zip(pred, gold) if p != positive and g == positive)
    if tp == 0:
        return 0.0
    precision = tp / (tp + fp)
    recall = tp / (tp + fn)
    return 2 * precision * recall / (precision + recall)


def roc_auc(labels: list[int], scores: list[float]) -> float:
    """ROC AUC（Mann-Whitney U 统计量，并列计 0.5）。"""
    pos = [s for l, s in zip(labels, scores) if l == 1]
    neg = [s for l, s in zip(labels, scores) if l != 1]
    if not pos or not neg:
        return 0.0
    wins = sum(1.0 if p > n else 0.5 if p == n else 0.0 for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


def emit_case_scores(
    predictions: PredictionBundle,
    gold: dict[str, Any],
    *,
    metric: str = "accuracy",
    score_scale: float = 100.0,
) -> None:
    """按 case 计算并写出标准结果；每 case 必带 ``hidden: true``，不写隐藏标签内容。

    ``metric`` 当前仅支持 ``accuracy``（其余度量以独立函数导出，由出题人组合）。
    ``gold`` 中的标签**只用于比对**，其内容绝不进入 ``details``。
    """
    from . import result  # 延迟导入，避免循环依赖

    if metric != "accuracy":  # pragma: no cover - 防御性，当前仅 accuracy
        raise ValueError(f"emit_case_scores 暂不支持 metric={metric!r}")

    cases = []
    correct = 0
    total = 0
    for pid, pred_val in zip(
        predictions.ids, (r.get("value") for r in predictions.rows)
    ):
        g = gold.get(str(pid))
        if g is None:
            continue
        total += 1
        ok = pred_val == g
        correct += 1 if ok else 0
        cases.append({
            "case_id": str(pid),
            "status": "Accepted" if ok else "WrongAnswer",
            "hidden": True,  # 唯一判据：不得省略
        })
    frac = (correct / total) if total else 0.0
    result.accept(score=frac * score_scale, details={"cases": cases})
