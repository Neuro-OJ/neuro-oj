"""
noj_solution_sdk 类型序列化层。

实现与错误类型映射到本 SDK 的 _RejectedTypeError，
具体编解码逻辑由 noj_sdk_common 共享。
"""

from __future__ import annotations

from typing import Any

from noj_sdk_common.serialization import (
    MAX_FRAME_BYTES,
    RejectedTypeError,
    check_frame_size as _check_frame_size,
    decode_value as _decode_value,
    encode_value as _encode_value,
    validate_type as _validate_type,
)

__all__ = [
    "MAX_FRAME_BYTES",
    "_RejectedTypeError",
    "check_frame_size",
    "decode_value",
    "encode_value",
    "validate_type",
]


class _RejectedTypeError(RejectedTypeError):
    """Solution SDK 内部类型契约异常（host 进程使用）。"""


def validate_type(value: Any, path: str = "<root>") -> None:
    """递归校验 value 是否仅含允许类型（错误映射为 _RejectedTypeError）。"""
    try:
        _validate_type(value, path)
    except RejectedTypeError as e:
        raise _RejectedTypeError(str(e)) from e


def check_frame_size(frame_str: str) -> None:
    """校验序列化后单帧不超过 MAX_FRAME_BYTES（错误映射为 _RejectedTypeError）。"""
    try:
        _check_frame_size(frame_str)
    except RejectedTypeError as e:
        raise _RejectedTypeError(str(e)) from e


encode_value = _encode_value
decode_value = _decode_value
