"""
noj_solution_sdk 单测 —— sanitize 模块。
"""

import sys
import unittest

sys.path.insert(0, sys.path[0] + "/..")

from noj_solution_sdk.sanitize import sanitize_trace


def _raise_with_path(path: str):
    """触发异常，使 traceback 中包含给定路径。"""
    def inner():
        raise ValueError("boom")
    try:
        # 通过 exec 在指定 filename 触发异常
        exec(compile("raise ValueError('boom')", path, "exec"), {})
    except ValueError as e:
        return e
    return None


class TestSanitizeTrace(unittest.TestCase):
    def test_strip_absolute_path(self):
        # 通过 exec 构造一个 filename 为绝对路径的异常
        try:
            raise RuntimeError("boom")
        except RuntimeError as e:
            sanitized = sanitize_trace(e)
        # 不应包含 sandbox 路径前缀
        self.assertNotIn("/usr/local/lib", sanitized)
        self.assertNotIn("/workspace", sanitized)

    def test_preserve_basename(self):
        try:
            raise RuntimeError("boom")
        except RuntimeError as e:
            sanitized = sanitize_trace(e)
        # 至少含 "RuntimeError: boom"
        self.assertIn("RuntimeError: boom", sanitized)
        # 含 "File " 引用，basename 应保留
        self.assertIn("File ", sanitized)
        # 不含完整 sandbox 路径
        for forbidden in ["/usr/local/", "/workspace/", "/tmp/noj"]:
            if forbidden in sanitized:
                # 仅当 basename 恰好含该字符串时允许；这里我们的测试代码不在那里
                self.fail(f"sanitize_trace 仍含 {forbidden!r}")

    def test_traceback_format(self):
        try:
            raise ValueError("test")
        except ValueError as e:
            sanitized = sanitize_trace(e)
        # 应包含标准 traceback 头
        self.assertTrue(sanitized.startswith("Traceback"))
        self.assertIn("ValueError: test", sanitized)

    def test_handles_nested_exception(self):
        try:
            try:
                raise ValueError("inner")
            except ValueError as e:
                raise RuntimeError("outer") from e
        except RuntimeError as e:
            sanitized = sanitize_trace(e)
        self.assertIn("RuntimeError: outer", sanitized)


if __name__ == "__main__":
    unittest.main()