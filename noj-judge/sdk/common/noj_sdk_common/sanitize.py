"""
noj_sdk_common 异常信息清洗（Evaluator / Solution 共享）。

剥离 traceback 中所有绝对路径，仅保留文件 basename + 行号 + 类名 + 消息，
防止异常 trace 反推容器镜像 layout 或 SDK 安装路径。
"""

from __future__ import annotations

import os
import re
import traceback
from typing import Optional

# 透传给对端（做题人）的异常 message 截断上限（防止超长消息 / 内嵌堆栈泄露）
DEFAULT_MAX_MESSAGE_LEN = 1024

# 标准 traceback 行格式: '  File "PATH", line N, in FUNC'
_TB_LINE_RE = re.compile(r'File "([^"]+)", line (\d+), in (.+)')

# 裸绝对路径（如 /workspace/secret/credentials.py）：message 中不总是带 File "..." 包装
_ABS_PATH_RE = re.compile(r"/(?:[\w.\-]+/)+[\w.\-]+")


def _sanitize_filename(path: str) -> str:
    """剥离目录前缀，仅保留 basename。"""
    return os.path.basename(path) or path


def _format_exception_with_tb(exc_type, exc_value, exc_tb) -> str:
    """手动构建清洗后的 traceback。"""
    lines = []
    lines.append("Traceback (most recent call last):")

    # 倒序遍历 traceback
    tb_list = []
    t = exc_tb
    while t is not None:
        tb_list.append(t)
        t = t.tb_next
    tb_list.reverse()

    for tb_frame in tb_list:
        frame = tb_frame.tb_frame
        filename = _sanitize_filename(tb_frame.tb_frame.f_code.co_filename)
        lineno = tb_frame.tb_lineno
        funcname = tb_frame.tb_frame.f_code.co_name
        lines.append(f'  File "{filename}", line {lineno}, in {funcname}')

    # 异常类型与消息
    exc_name = getattr(exc_type, "__name__", str(exc_type))
    lines.append(f"{exc_name}: {exc_value}")
    return "\n".join(lines)


def _format_exception_from_exc_info() -> str:
    import sys

    exc_type, exc_value, exc_tb = sys.exc_info()
    if exc_type is None:
        return ""
    return _format_exception_with_tb(exc_type, exc_value, exc_tb)


def sanitize_trace(tb_exc: Optional[BaseException] = None) -> str:
    """返回清洗后的 traceback 字符串。

    规则：
    - 文件路径替换为 basename（去掉目录）
    - 保留行号、函数名、类名、消息
    - 多行格式保持与标准 traceback 一致

    Args:
        tb_exc: 若提供则格式化其 traceback；否则用当前正在处理的异常（sys.exc_info）
    """
    if tb_exc is not None:
        return _format_exception_with_tb(type(tb_exc), tb_exc, tb_exc.__traceback__)
    return _format_exception_from_exc_info()


def sanitize_traceback(exc: BaseException) -> str:
    """清洗异常 traceback（Evaluator 侧错误帧使用）。"""
    return sanitize_trace(exc)


def sanitize_message(msg: str, max_len: int = DEFAULT_MAX_MESSAGE_LEN) -> str:
    """净化透传给对端的异常 `message`：路径只保留 basename + 截断长度。

    `str(e)` 可能内嵌绝对路径（`File "..."` 或裸路径）/ 长堆栈 / 敏感值，
    做一致的路径清洗，并截断到上限，防止信息泄露与超大帧。
    """
    cleaned = _TB_LINE_RE.sub(
        lambda m: f'File "{_sanitize_filename(m.group(1))}", line {m.group(2)}, in {m.group(3)}',
        msg,
    )
    cleaned = _ABS_PATH_RE.sub(
        lambda m: f"/{_sanitize_filename(m.group(0))}", cleaned
    )
    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len] + f"...（截断，原长度 {len(msg)}）"
    return cleaned
