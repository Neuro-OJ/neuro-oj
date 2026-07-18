"""
noj_solution_sdk trace 路径清洗。

剥离 traceback 中所有绝对路径，仅保留文件 basename + 行号 + 类名 + 消息。
防止 Solution 侧异常 trace 反推容器镜像 layout 或 SDK 安装路径。
"""

from __future__ import annotations

import os
import re
import traceback


def sanitize_trace(tb_exc: BaseException | None = None) -> str:
    """返回清洗后的 traceback 字符串。

    规则：
    - 文件路径替换为 basename（去掉目录）
    - 保留行号、函数名、类名、消息
    - 多行格式保持与标准 traceback 一致

    Args:
        tb_exc: 若提供则格式化其 traceback；否则用当前正在处理的异常（sys.exc_info）
    """
    if tb_exc is not None:
        return _format_exception(tb_exc)
    # 当前正在处理的异常
    return _format_exception_from_exc_info()


def _format_exception_from_exc_info() -> str:
    import sys

    exc_type, exc_value, exc_tb = sys.exc_info()
    if exc_type is None:
        return ""
    return _format_exception_with_tb(exc_type, exc_value, exc_tb)


def _format_exception(exc: BaseException) -> str:
    return _format_exception_with_tb(type(exc), exc, exc.__traceback__)


# 标准 traceback 行格式: '  File "PATH", line N, in FUNC'
_TB_LINE_RE = re.compile(r'File "([^"]+)", line (\d+), in (.+)')


def _sanitize_filename(path: str) -> str:
    """剥离目录前缀，仅保留 basename。"""
    return os.path.basename(path) or path


def _format_exception_with_tb(exc_type, exc_value, exc_tb) -> str:
    """手动构建清洗后的 traceback。"""
    lines = []
    lines.append(f"Traceback (most recent call last):")

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