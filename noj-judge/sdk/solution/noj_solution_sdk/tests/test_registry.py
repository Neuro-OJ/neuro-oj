"""
noj_solution_sdk 单测 —— registry 模块。
"""

import sys
import unittest

sys.path.insert(0, sys.path[0] + "/..")

from noj_solution_sdk.registry import (
    FunctionAlreadyRegisteredError,
    get_registry,
    register,
)


class TestRegister(unittest.TestCase):
    def setUp(self):
        # 每个测试前清空注册表
        get_registry()._functions.clear()

    def test_register_decorator(self):
        @register
        def solve(a, b):
            return a + b

        self.assertIn("solve", get_registry().names())

    def test_register_with_explicit_name(self):
        def fn():
            pass

        register("my_fn", fn)
        self.assertIn("my_fn", get_registry().names())

    def test_register_duplicate_raises(self):
        @register
        def f():
            pass

        with self.assertRaises(FunctionAlreadyRegisteredError):
            register("f", lambda: None)

    def test_register_non_callable_raises(self):
        with self.assertRaises(TypeError):
            register("bad", 42)  # 装饰器形式

        with self.assertRaises(TypeError):
            register("bad", 42)  # 显式 name 形式

    def test_register_first_arg_must_be_str_in_explicit_form(self):
        with self.assertRaises(TypeError):
            register(123, lambda: None)

    def test_get_returns_function(self):
        @register
        def solve():
            return "x"

        self.assertIs(get_registry().get("solve"), solve)

    def test_get_unknown_returns_none(self):
        self.assertIsNone(get_registry().get("nope"))


if __name__ == "__main__":
    unittest.main()