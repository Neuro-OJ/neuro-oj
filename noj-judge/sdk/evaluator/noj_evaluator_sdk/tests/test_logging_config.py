"""
noj_evaluator_sdk 单测 —— logging_config + 协议约定。

验证 configure_logging 后 SDK 自身 print 不污染 stdout。
"""

import io
import logging
import sys
import unittest

sys.path.insert(0, sys.path[0] + "/..")

import noj_evaluator_sdk.logging_config as logging_config


class TestConfigureLogging(unittest.TestCase):
    def setUp(self):
        self._stdout_buf = io.StringIO()
        self._stderr_buf = io.StringIO()
        self._orig_stdout = sys.stdout
        self._orig_stderr = sys.stderr
        sys.stdout = self._stdout_buf
        sys.stderr = self._stderr_buf

    def tearDown(self):
        sys.stdout = self._orig_stdout
        sys.stderr = self._orig_stderr
        # 恢复 logging root
        logging.getLogger().handlers = []

    def test_logging_redirects_to_stderr(self):
        logging_config.configure_logging(level=logging.INFO)
        logging.info("hello from sdk")
        self.assertIn("hello from sdk", self._stderr_buf.getvalue())
        self.assertEqual(self._stdout_buf.getvalue(), "")

    def test_sdk_print_alias_to_stderr(self):
        logging_config.configure_logging()
        sdk_print = logging_config.print  # 重定向后的 print
        sdk_print("via sdk print")
        self.assertIn("via sdk print", self._stderr_buf.getvalue())
        self.assertEqual(self._stdout_buf.getvalue(), "")


if __name__ == "__main__":
    unittest.main()