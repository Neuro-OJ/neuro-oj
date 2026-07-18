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