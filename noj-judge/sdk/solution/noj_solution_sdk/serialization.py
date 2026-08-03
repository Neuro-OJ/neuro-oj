"""
noj_solution_sdk 类型序列化层。

镜像 noj_evaluator_sdk：只接受 7 种基本类型 + bytes base64。
"""

from __future__ import annotations

import base64
from typing import Any

# 仅用于错误上报（host 进程内部使用，避免与 evaluator SDK 循环依赖）
class _RejectedTypeError(Exception):
    pass


# 复用 evaluator 的实现：通过相对路径或导入
try:
    from noj_evaluator_sdk.serialization import (
        encode_value,
        decode_value,
        MAX_FRAME_BYTES,
    )
except ImportError:
    # 在没有 evaluator SDK 路径的情况下（如单独打包镜像）走本地副本
    def encode_value(value: Any) -> Any:
        if isinstance(value, (bytes, bytearray, memoryview)):
            return {"__bytes__": base64.b64encode(bytes(value)).decode("ascii")}
        if isinstance(value, list):
            return [encode_value(v) for v in value]
        if isinstance(value, dict):
            return {k: encode_value(v) for k, v in value.items()}
        return value

    def decode_value(value: Any) -> Any:
        if isinstance(value, dict):
            if set(value.keys()) == {"__bytes__"} and isinstance(value["__bytes__"], str):
                return base64.b64decode(value["__bytes__"])
            return {k: decode_value(v) for k, v in value.items()}
        if isinstance(value, list):
            return [decode_value(v) for v in value]
        return value

    MAX_FRAME_BYTES = 1 * 1024 * 1024


def validate_type(value: Any, path: str = "<root>") -> None:
    """递归校验 value 是否仅含允许类型（None/bool/int/float/str/bytes/list/dict）。

    list / dict 内部继续递归；不允许 set、tuple、自定义类、函数等。
    与 noj_evaluator_sdk.validate_type 语义一致（RPC 类型契约）。
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
                raise _RejectedTypeError(
                    f"{path}: dict key 必须是 str，实际 {type(k).__name__}"
                )
            validate_type(v, f"{path}.{k}")
        return
    raise _RejectedTypeError(
        f"{path}: 不支持的类型 {type(value).__name__}（仅 None/bool/int/float/str/bytes/list/dict）"
    )


def check_frame_size(frame_str: str) -> None:
    """校验序列化后单帧不超过 MAX_FRAME_BYTES（1 MiB 软上限）。"""
    encoded = frame_str.encode("utf-8")
    if len(encoded) > MAX_FRAME_BYTES:
        raise _RejectedTypeError(
            f"frame size {len(encoded)} > {MAX_FRAME_BYTES}（单帧 1 MiB 软上限）"
        )