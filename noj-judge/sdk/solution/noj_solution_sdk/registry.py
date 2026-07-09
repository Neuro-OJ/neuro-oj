"""
noj_solution_sdk 函数注册表。

`register(fn)` 用函数名 `fn.__name__` 注册。
`register(name, fn)` 显式指定名称。
"""

from __future__ import annotations

from threading import RLock
from typing import Any, Callable


class FunctionAlreadyRegisteredError(Exception):
    """重复注册同名函数。"""


class NotRegisteredError(Exception):
    """内部错误：未注册的函数不应被调用。"""


class _Registry:
    """线程安全单例函数注册表。"""

    def __init__(self):
        self._functions: dict[str, Callable] = {}
        self._lock = RLock()

    def register(self, name: str, fn: Callable) -> None:
        with self._lock:
            if name in self._functions:
                raise FunctionAlreadyRegisteredError(
                    f"function {name!r} already registered"
                )
            self._functions[name] = fn

    def get(self, name: str) -> Callable | None:
        with self._lock:
            return self._functions.get(name)

    def names(self) -> list[str]:
        with self._lock:
            return list(self._functions.keys())


_REGISTRY = _Registry()


def get_registry() -> _Registry:
    """获取全局注册表（测试用）。"""
    return _REGISTRY


def register(arg1: Any, arg2: Any = None) -> None:
    """注册函数供 Evaluator 调用。

    两种形式：
        @register
        def solve(a, b): ...

        register("solve", solve)
    """
    if arg2 is None:
        # 装饰器形式：arg1 = fn
        fn = arg1
        if not callable(fn):
            raise TypeError(f"register 装饰器要求 callable，实际 {type(fn).__name__}")
        name = getattr(fn, "__name__", None)
        if not name:
            raise ValueError("function 缺少 __name__，请用 register(name, fn) 形式")
        _REGISTRY.register(name, fn)
        return fn
    # 显式 name 形式：arg1 = name, arg2 = fn
    if not isinstance(arg1, str):
        raise TypeError(f"register 第一个参数必须是 str，实际 {type(arg1).__name__}")
    if not callable(arg2):
        raise TypeError(f"register 第二个参数必须是 callable，实际 {type(arg2).__name__}")
    _REGISTRY.register(arg1, arg2)