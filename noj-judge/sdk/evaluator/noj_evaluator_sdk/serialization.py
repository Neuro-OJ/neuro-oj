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