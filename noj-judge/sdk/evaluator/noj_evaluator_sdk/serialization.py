"""
noj_evaluator_sdk 类型序列化层。

只接受以下 7 种基本类型（+ bytes base64）：
    None / bool / int / float / str / bytes / list / dict

任何其他类型（包括嵌套中的）抛 `RejectedError`。
bytes 通过 base64 编码在 NDJSON 中传输（避免二进制损坏 NDJSON 帧）。
"""

from __future__ import annotations

import base64
from typing import Any

from .errors import RejectedError

# 限制单帧序列化字节数（1 MiB 软上限）
MAX_FRAME_BYTES = 1 * 1024 * 1024


def validate_type(value: Any, path: str = "<root>") -> None:
    """递归校验 value 是否仅含允许类型。

    不允许：set、tuple、自定义类、函数、生成器、socket、文件句柄等。
    list / dict 内部继续递归。
    """
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, (int, float, str)):
        return
    if isinstance(value, (bytes, bytearray, memoryview)):
        return
    if isinstance(value, list):
        for i, item in enumerate(value):
            validate_type(item, f"{path}[{i}]")
        return
    if isinstance(value, dict):
        for k, v in value.items():
            if not isinstance(k, str):
                raise RejectedError(
                    f"{path}: dict key 必须是 str，实际 {type(k).__name__}"
                )
            validate_type(v, f"{path}.{k}")
        return
    raise RejectedError(
        f"{path}: 不支持的类型 {type(value).__name__}（仅 None/bool/int/float/str/bytes/list/dict）"
    )


def encode_value(value: Any) -> Any:
    """把 Python 值转为 JSON 可序列化结构。

    - bytes / bytearray / memoryview → base64 字符串
    - 其他允许类型 → 原样
    """
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"__bytes__": base64.b64encode(bytes(value)).decode("ascii")}
    if isinstance(value, list):
        return [encode_value(v) for v in value]
    if isinstance(value, dict):
        return {k: encode_value(v) for k, v in value.items()}
    return value


def decode_value(value: Any) -> Any:
    """把 JSON 反序列化结构还原为 Python 值。

    - `{"__bytes__": "<base64>"}` → bytes
    """
    if isinstance(value, dict):
        if set(value.keys()) == {"__bytes__"} and isinstance(value["__bytes__"], str):
            return base64.b64decode(value["__bytes__"])
        return {k: decode_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [decode_value(v) for v in value]
    return value


def check_frame_size(frame_str: str) -> None:
    """校验序列化后单帧不超过 MAX_FRAME_BYTES。"""
    encoded = frame_str.encode("utf-8")
    if len(encoded) > MAX_FRAME_BYTES:
        raise RejectedError(
            f"frame size {len(encoded)} > {MAX_FRAME_BYTES}（单帧 1 MiB 软上限）"
        )


def estimate_frame_size(value: Any) -> int:
    """估算 value 序列化后帧字节数的上界（不复制数据，超限即短路）。

    用于在 `encode_value`（bytes → base64 膨胀 ~1.33×）之前预检超大返回值，
    避免对必然超限的大对象（如 handler 返回 1 GB dict）先吃完整序列化内存。
    估算为宽松上界（≥ 实际序列化字节数），因此"估算 > MAX_FRAME_BYTES 即拒绝"
    不会误伤合法值；边界附近仍由 `check_frame_size` 做最终判定。
    """
    total = 0

    def walk(v: Any) -> None:
        nonlocal total
        if total > MAX_FRAME_BYTES:
            return
        if isinstance(v, str):
            total += len(v.encode("utf-8")) + 2  # JSON 引号
        elif isinstance(v, (bytes, bytearray, memoryview)):
            # base64 编码后 ~1.33× 膨胀 + 包装 {"__bytes__": "..."}
            total += len(bytes(v)) * 4 // 3 + 20
        elif isinstance(v, (int, float, bool)) or v is None:
            total += 24  # 数字/布尔/空值 JSON 字面量粗略上界
        elif isinstance(v, list):
            total += 2  # []
            for item in v:
                total += 1  # 逗号
                walk(item)
                if total > MAX_FRAME_BYTES:
                    return
        elif isinstance(v, dict):
            total += 2  # {}
            for k, kv in v.items():
                if not isinstance(k, str):
                    total += 64  # 非 str key（validate_type 前置校验已拒绝）
                else:
                    total += len(k.encode("utf-8")) + 4  # 引号 + 冒号
                walk(kv)
                if total > MAX_FRAME_BYTES:
                    return
        else:
            total += 64  # 未知类型兜底

    walk(value)
    return total