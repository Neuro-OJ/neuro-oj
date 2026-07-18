"""
noj_evaluator_sdk 单测 —— result 模块。

捕获 stdout 验证 `---RESULT---` 标记格式。
"""

import io
import json
import sys
import unittest

sys.path.insert(0, sys.path[0] + "/..")

from noj_evaluator_sdk.result import Result


class TestResultWrite(unittest.TestCase):
    """验证 Result 写入格式。"""

    def setUp(self):
        self._stdout_buf = io.StringIO()
        self._orig_stdout = sys.stdout
        sys.stdout = self._stdout_buf

    def tearDown(self):
        sys.stdout = self._orig_stdout

    def _read_written(self) -> dict:
        output = self._stdout_buf.getvalue()
        self.assertIn("---RESULT---", output)
        # 取标记后的第一行 JSON
        lines = output.split("---RESULT---", 1)[1].strip().split("\n")
        return json.loads(lines[0])

    def test_accept_default(self):
        r = Result()
        r.accept()
        data = self._read_written()
        self.assertEqual(data["status"], "Accepted")
        self.assertEqual(data["score"], 10000)  # 100 × 100

    def test_wrong_answer_with_message(self):
        r = Result()
        r.wrong_answer(message="expected 3 got 4")
        data = self._read_written()
        self.assertEqual(data["status"], "WrongAnswer")
        self.assertEqual(data["score"], 0)
        self.assertEqual(data["details"]["message"], "expected 3 got 4")

    def test_double_write_raises(self):
        r = Result()
        r.accept()
        with self.assertRaises(RuntimeError):
            r.wrong_answer()

    def test_score_scaling(self):
        r = Result()
        r.accept(score=87.5)  # 应存为 8750
        data = self._read_written()
        self.assertEqual(data["score"], 8750)


if __name__ == "__main__":
    unittest.main()