"""
noj_evaluator_sdk 日志配置。

`configure_logging()` 把所有 print 与 logging 重定向到 stderr，确保 stdout 仅含
NDJSON 协议帧与 `---RESULT---` 标记——这是与 judge 通信的前提。

不强制替换 evaluate.py 中直接的 print（evaluate.py 作者仍可能误用 stdout），
但 SDK 自身在调用 `configure_logging()` 后绝不会污染 stdout。
"""

from __future__ import annotations

import logging
import sys


def configure_logging(level: int = logging.INFO) -> None:
    """配置 logging + print 重定向到 stderr。

    调用时机：evaluate.py 入口处先 `configure_logging()` 再 import 业务模块。
    """
    # 1. logging 重定向到 stderr
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
    )
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)

    # 2. print 重定向到 stderr（通过替换 builtins.print 仅在当前模块作用域生效）
    #    注意：此替换只影响 `from noj_evaluator_sdk import print` 的形式，
    #    无法拦截 evaluate.py 中直接的 print。这是设计选择：文档警示。
    #    真正的防护是 SDK 内部所有 IO 仅通过 stderr。
    import builtins as _builtins  # noqa: F401

    def _stderr_print(*args, **kwargs):
        kwargs.setdefault("file", sys.stderr)
        _builtins.print(*args, **kwargs)

    # 暴露为模块属性，让 `from noj_evaluator_sdk import print` 用户可显式使用
    globals()["print"] = _stderr_print