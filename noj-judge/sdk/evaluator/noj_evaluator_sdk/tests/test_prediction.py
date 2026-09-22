"""
noj_evaluator_sdk 单测 —— prediction 模块。

覆盖：
- 安全加载：扩展名拒绝、NUL 字节拒绝、目录自动定位、ID 对齐校验；
- 纯 Python 确定性度量；
- `emit_case_scores` 写出 `---RESULT---` 且每个 case 带 `hidden: true`（不泄漏隐藏标签）。

约束：本模块与 `prediction.py` 的 import **不得依赖 numpy**（evaluator 基础镜像
为 python:3.12-slim，无 numpy）。
"""

import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

# 与既有 SDK 测试保持一致的写法（历史遗留：tests/ 现已位于包内，Python ≥3.11
# 下 sys.path[0] 为绝对路径，该条目实际指向包目录本身）。
_HERE = os.path.abspath(sys.path[0])
sys.path.insert(0, _HERE + "/..")
# 补齐真正需要的两个位置，使 `python3 test_prediction.py` 可独立运行：
#   sdk/evaluator  —— 含 noj_evaluator_sdk 包
#   sdk/common     —— 含 noj_sdk_common（被包 __init__ 间接导入）
_EVALUATOR_ROOT = os.path.normpath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, _EVALUATOR_ROOT)
sys.path.insert(0, os.path.join(os.path.dirname(_EVALUATOR_ROOT), "common"))

from noj_evaluator_sdk.prediction import (  # noqa: E402
    PredictionBundle,
    accuracy,
    assert_id_alignment,
    emit_case_scores,
    f1_score,
    load_predictions,
    mae,
    rmse,
    roc_auc,
    values_equal,
)


def _write(path: str, content: str) -> str:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)
    return path


class TestLoadPredictions(unittest.TestCase):
    """Task 11：安全加载与定位。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.addCleanup(self._tmp.cleanup)
        # 隔离环境变量，避免影响其它用例。
        self._orig_dir = os.environ.get("NOJ_PREDICTION_DIR")
        os.environ.pop("NOJ_PREDICTION_DIR", None)
        self.addCleanup(self._restore_env)

    def _restore_env(self):
        if self._orig_dir is None:
            os.environ.pop("NOJ_PREDICTION_DIR", None)
        else:
            os.environ["NOJ_PREDICTION_DIR"] = self._orig_dir

    def test_load_jsonl(self):
        p = _write(
            os.path.join(self.dir, "pred.jsonl"),
            '{"id": "a", "value": 1}\n{"id": "b", "value": 0}\n',
        )
        bundle = load_predictions(p)
        self.assertIsInstance(bundle, PredictionBundle)
        self.assertEqual(bundle.columns, ["id", "value"])
        self.assertEqual(bundle.ids, ["a", "b"])
        self.assertEqual(bundle.rows[1]["value"], 0)
        self.assertEqual(bundle.path, p)

    def test_load_csv(self):
        p = _write(os.path.join(self.dir, "pred.csv"), "id,value\na,1\nb,0\n")
        bundle = load_predictions(p)
        self.assertEqual(bundle.columns, ["id", "value"])
        self.assertEqual(bundle.ids, ["a", "b"])
        self.assertEqual([r["value"] for r in bundle.rows], ["1", "0"])

    def test_load_tsv(self):
        p = _write(os.path.join(self.dir, "pred.tsv"), "id\tvalue\na\t1\n")
        bundle = load_predictions(p)
        self.assertEqual(bundle.columns, ["id", "value"])
        self.assertEqual(bundle.rows[0]["value"], "1")

    def test_load_json_list(self):
        p = _write(
            os.path.join(self.dir, "pred.json"),
            json.dumps([{"id": "a", "value": 1}, {"id": "b", "value": 0}]),
        )
        bundle = load_predictions(p)
        self.assertEqual(bundle.ids, ["a", "b"])

    def test_ids_fallback_to_row_index(self):
        p = _write(os.path.join(self.dir, "pred.csv"), "value\n1\n0\n")
        bundle = load_predictions(p)
        self.assertEqual(bundle.ids, ["0", "1"])

    def test_reject_pickle_extension(self):
        for ext in (".pkl", ".pickle", ".pt", ".pth", ".bin", ".joblib", ".ckpt"):
            p = os.path.join(self.dir, f"pred{ext}")
            with open(p, "wb") as fh:
                fh.write(b"\x80\x04not-really")  # 不得被解析
            with self.assertRaises(ValueError):
                load_predictions(p)

    def test_reject_nul_bytes_in_text(self):
        p = os.path.join(self.dir, "pred.jsonl")
        with open(p, "wb") as fh:
            fh.write(b'{"id":"a","value":1}\x00\n')
        with self.assertRaises(ValueError):
            load_predictions(p)

    def test_reject_unsupported_extension(self):
        p = _write(os.path.join(self.dir, "pred.xyz"), "a,1\n")
        with self.assertRaises(ValueError):
            load_predictions(p)

    def test_single_file_dir_autodetect(self):
        _write(os.path.join(self.dir, "only.jsonl"), '{"id": "a", "value": 1}\n')
        os.environ["NOJ_PREDICTION_DIR"] = self.dir
        bundle = load_predictions()
        self.assertEqual(bundle.ids, ["a"])

    def test_multiple_files_dir_errors(self):
        _write(os.path.join(self.dir, "a.jsonl"), '{"id": "a", "value": 1}\n')
        _write(os.path.join(self.dir, "b.jsonl"), '{"id": "b", "value": 0}\n')
        os.environ["NOJ_PREDICTION_DIR"] = self.dir
        with self.assertRaises(ValueError):
            load_predictions()

    def test_missing_dir_errors(self):
        os.environ["NOJ_PREDICTION_DIR"] = os.path.join(self.dir, "does-not-exist")
        with self.assertRaises(FileNotFoundError):
            load_predictions()

    def test_assert_id_alignment_ok(self):
        bundle = PredictionBundle(
            path="x", columns=["value"], rows=[{"value": 1}, {"value": 0}]
        )
        assert_id_alignment(bundle, ["0", "1"])  # 不抛异常

    def test_assert_id_alignment_mismatch(self):
        p = _write(os.path.join(self.dir, "pred.csv"), "id,value\na,1\nb,0\n")
        bundle = load_predictions(p)
        with self.assertRaises(ValueError):
            assert_id_alignment(bundle, ["a", "c"])

    def test_assert_id_alignment_rejects_duplicate_ids(self):
        """重复预测 ID 曾被 set 比较放过，导致同一 gold 被重复计分（Task 11 复审修复）。"""
        bundle = PredictionBundle(
            path="x",
            columns=["id", "value"],
            rows=[{"id": "a", "value": 1}, {"id": "a", "value": 1}],
        )
        with self.assertRaises(ValueError) as ctx:
            assert_id_alignment(bundle, ["a"])
        self.assertIn("重复", str(ctx.exception))

    def test_assert_id_alignment_rejects_length_mismatch(self):
        """ID 集合相同但数量不同（如预测多一行缺失 id 的回退行号）也必须报错。"""
        bundle = PredictionBundle(
            path="x",
            columns=["value"],
            rows=[{"value": 1}, {"value": 1}],
        )
        with self.assertRaises(ValueError):
            assert_id_alignment(bundle, ["0"])

    def test_assert_id_alignment_duplicate_and_missing_named(self):
        """同时存在重复与缺失时，错误信息应分别点出，便于出题人定位。"""
        bundle = PredictionBundle(
            path="x",
            columns=["id", "value"],
            rows=[{"id": "a", "value": 1}, {"id": "a", "value": 1}],
        )
        with self.assertRaises(ValueError) as ctx:
            assert_id_alignment(bundle, ["a", "b"])
        msg = str(ctx.exception)
        self.assertIn("重复", msg)
        self.assertIn("缺少", msg)

    def test_assert_id_alignment_is_linear_on_large_inputs(self):
        """大预测文件必须线性完成（原实现逐元素 list.count 是 O(n²)）。

        5 万行时旧实现需要约 15 秒、10 万行约 67 秒，会白白吃掉评测时限；
        这里给出宽松上限，只拦截复杂度回归而非机器差异。
        """
        n = 50_000
        bundle = PredictionBundle(
            path="x",
            columns=["value"],
            rows=[{"value": 0} for _ in range(n)],
        )
        expected = [str(i) for i in range(n)]
        start = time.perf_counter()
        assert_id_alignment(bundle, expected)  # 不抛异常
        elapsed = time.perf_counter() - start
        self.assertLess(
            elapsed,
            5.0,
            f"{n} 行对齐校验耗时 {elapsed:.2f}s，疑似退回 O(n²) 实现",
        )

    def test_assert_id_alignment_duplicates_reported_on_large_inputs(self):
        """线性实现仍需正确报出大输入中的重复 ID。"""
        rows = [{"id": str(i), "value": 0} for i in range(1000)]
        rows.append({"id": "999", "value": 0})
        bundle = PredictionBundle(path="x", columns=["id", "value"], rows=rows)
        expected = [str(i) for i in range(1000)]
        with self.assertRaises(ValueError) as ctx:
            assert_id_alignment(bundle, expected)
        msg = str(ctx.exception)
        self.assertIn("重复 1 个['999']", msg)
        self.assertIn("缺少 0 个[]", msg)

    def test_numpy_branch_requires_numpy_when_absent(self):
        try:
            import numpy  # noqa: F401
        except ImportError:
            has_numpy = False
        else:
            has_numpy = True
        p = os.path.join(self.dir, "pred.npy")
        with open(p, "wb") as fh:
            fh.write(b"\x93NUMPY-irrelevant")
        if has_numpy:
            # 环境有 numpy 时不做断言（本仓库 evaluator 镜像无 numpy）。
            self.skipTest("环境存在 numpy，跳过缺失路径断言")
        with self.assertRaises(RuntimeError):
            load_predictions(p)


class TestNumpyIndependence(unittest.TestCase):
    """确保 prediction 模块 import 不引入 numpy。"""

    def test_import_prediction_without_numpy(self):
        evaluator_root = os.path.normpath(
            os.path.join(os.path.dirname(__file__), "..", "..")
        )
        common_root = os.path.join(os.path.dirname(evaluator_root), "common")
        code = (
            "import sys\n"
            f"sys.path.insert(0, {evaluator_root!r})\n"
            f"sys.path.insert(0, {common_root!r})\n"
            "import noj_evaluator_sdk.prediction as m\n"
            "assert m.accuracy([1], [1]) == 1.0\n"
            "assert 'numpy' not in sys.modules, 'import 意外引入 numpy'\n"
            "print('NO_NUMPY_OK')\n"
        )
        proc = subprocess.run(
            [sys.executable, "-c", code],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertIn("NO_NUMPY_OK", proc.stdout)


class TestValuesEqual(unittest.TestCase):
    """Task 12 复审：emit_case_scores 的逐 case 比较归一化。"""

    def test_numeric_string_equals_number(self):
        self.assertTrue(values_equal("1", 1))
        self.assertTrue(values_equal("0.5", 0.5))
        self.assertTrue(values_equal(1, "1"))  # 参数顺序无关

    def test_numeric_string_not_equal_wrong_number(self):
        self.assertFalse(values_equal("1", 0))

    def test_numeric_numeric_tolerant(self):
        # 相对/绝对容差内的浮点差异视为相等
        self.assertTrue(values_equal(0.1 + 0.2, 0.3))
        self.assertFalse(values_equal(0.1, 0.3))

    def test_non_numeric_exact_string(self):
        self.assertTrue(values_equal("cat", "cat"))
        self.assertFalse(values_equal("cat", "dog"))
        self.assertFalse(values_equal("1", "cat"))  # 一侧非数值 → 严格字符串比较

    def test_bool_not_equal_number(self):
        # True == 1 在 Python 为真，但本题语义上布尔与数值应可区分
        self.assertFalse(values_equal(True, 1))
        self.assertFalse(values_equal("1", True))
        self.assertTrue(values_equal(True, True))
        self.assertFalse(values_equal(True, False))

    def test_none_handling(self):
        self.assertTrue(values_equal(None, None))
        self.assertFalse(values_equal(None, 1))
        self.assertFalse(values_equal(None, "None"))

    def test_nested_values_exact(self):
        self.assertTrue(values_equal([1, 2], [1, 2]))
        self.assertFalse(values_equal([1, 2], [1, 3]))


class TestMetrics(unittest.TestCase):
    """Task 12：确定性纯 Python 度量。"""

    def test_accuracy_basic(self):
        self.assertAlmostEqual(accuracy([1, 0, 1], [1, 1, 1]), 2 / 3)

    def test_accuracy_empty(self):
        self.assertEqual(accuracy([], []), 0.0)

    def test_accuracy_length_mismatch_raises(self):
        with self.assertRaises(ValueError) as ctx:
            accuracy([1, 0], [1])
        self.assertIn("长度", str(ctx.exception))

    def test_f1_score_basic(self):
        # tp=1, fp=1, fn=0 → precision=recall=0.5 → f1=0.5
        self.assertAlmostEqual(f1_score([1, 1, 0], [1, 0, 1]), 0.5)

    def test_f1_score_no_positive(self):
        self.assertEqual(f1_score([0, 0], [0, 1]), 0.0)

    def test_f1_score_length_mismatch_raises(self):
        with self.assertRaises(ValueError):
            f1_score([1, 1], [1])

    def test_rmse_basic(self):
        self.assertAlmostEqual(rmse([1.0, 2.0], [1.0, 4.0]), (2.0) ** 0.5)

    def test_mae_basic(self):
        self.assertAlmostEqual(mae([1.0, 2.0], [1.0, 4.0]), 1.0)

    def test_rmse_length_mismatch_raises(self):
        with self.assertRaises(ValueError):
            rmse([1.0, 2.0], [1.0])

    def test_mae_length_mismatch_raises(self):
        with self.assertRaises(ValueError):
            mae([1.0], [1.0, 2.0])

    def test_empty_gold_still_zero_after_guard(self):
        # gold 为空时保持 0.0（守卫不改变该行为）
        self.assertEqual(accuracy([1], []), 0.0)
        self.assertEqual(rmse([1.0], []), 0.0)
        self.assertEqual(mae([1.0], []), 0.0)
        self.assertEqual(roc_auc([], []), 0.0)

    def test_roc_auc_perfect(self):
        self.assertEqual(roc_auc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]), 1.0)

    def test_roc_auc_reversed(self):
        self.assertEqual(roc_auc([0, 0, 1, 1], [0.9, 0.8, 0.2, 0.1]), 0.0)

    def test_roc_auc_ties_count_half(self):
        self.assertEqual(roc_auc([0, 1], [0.5, 0.5]), 0.5)

    def test_roc_auc_single_class(self):
        self.assertEqual(roc_auc([1, 1], [0.1, 0.2]), 0.0)


class TestEmitCaseScores(unittest.TestCase):
    """Task 12：结果集成。"""

    def setUp(self):
        self._stdout_buf = io.StringIO()
        self._orig_stdout = sys.stdout
        sys.stdout = self._stdout_buf
        # `result` 是包级单例，只允许写一次；逐用例重置写入标记。
        import noj_evaluator_sdk

        noj_evaluator_sdk.result._written = False

    def tearDown(self):
        sys.stdout = self._orig_stdout

    def _read_written(self) -> dict:
        output = self._stdout_buf.getvalue()
        self.assertIn("---RESULT---", output)
        lines = output.split("---RESULT---", 1)[1].strip().split("\n")
        return json.loads(lines[0])

    def _bundle(self) -> PredictionBundle:
        return PredictionBundle(
            path="p",
            columns=["value"],
            rows=[{"value": 1}, {"value": 0}, {"value": 1}],
        )

    def test_emit_cases_hidden_flag(self):
        emit_case_scores(self._bundle(), {"0": 1, "1": 0, "2": 0})
        data = self._read_written()
        cases = data["details"]["cases"]
        self.assertEqual(len(cases), 3)
        for case in cases:
            self.assertIs(case["hidden"], True)
        self.assertEqual(
            [c["status"] for c in cases], ["Accepted", "Accepted", "WrongAnswer"]
        )

    def test_emit_case_scores_uses_full_scale(self):
        emit_case_scores(self._bundle(), {"0": 1, "1": 0, "2": 0})
        data = self._read_written()
        self.assertEqual(data["score"], int(round((2 / 3) * 100 * 100)))

    def test_emit_case_scores_custom_scale(self):
        emit_case_scores(self._bundle(), {"0": 1, "1": 0, "2": 0}, score_scale=1.0)
        data = self._read_written()
        self.assertEqual(data["score"], 67)  # round(0.666… ×100)

    def test_emit_does_not_leak_hidden_labels(self):
        secret_gold = {"0": "GOLD-SECRET-0", "1": "GOLD-SECRET-1", "2": "GOLD-SECRET-2"}
        emit_case_scores(self._bundle(), secret_gold)
        output = self._stdout_buf.getvalue()
        for secret in secret_gold.values():
            self.assertNotIn(secret, output)
        data = self._read_written()
        self.assertNotIn("gold", data["details"])

    def test_emit_skips_unknown_ids(self):
        emit_case_scores(self._bundle(), {"0": 1})
        data = self._read_written()
        self.assertEqual(len(data["details"]["cases"]), 1)
        self.assertEqual(data["details"]["cases"][0]["case_id"], "0")

    def test_emit_string_values_match_numeric_gold(self):
        """CSV 行恒为 str，gold 为 int/float；曾因严格 == 全体判错（Task 12 复审修复）。"""
        bundle = PredictionBundle(
            path="p",
            columns=["id", "value"],
            rows=[
                {"id": "a", "value": "1"},
                {"id": "b", "value": "0"},
                {"id": "c", "value": "0.5"},
            ],
        )
        emit_case_scores(bundle, {"a": 1, "b": 0, "c": 0.5})
        data = self._read_written()
        cases = data["details"]["cases"]
        self.assertEqual([c["status"] for c in cases], ["Accepted"] * 3)
        self.assertEqual(data["score"], int(round(1.0 * 100 * 100)))

    def test_emit_string_values_wrong_number_still_wrong(self):
        bundle = PredictionBundle(path="p", columns=["value"], rows=[{"value": "1"}])
        emit_case_scores(bundle, {"0": 0}, score_scale=100.0)
        data = self._read_written()
        self.assertEqual(data["details"]["cases"][0]["status"], "WrongAnswer")
        self.assertEqual(data["score"], 0)

    def test_duplicate_ids_rejected_before_scoring(self):
        """集成路径：重复 ID 必须先被 assert_id_alignment 拒绝，避免同一 gold 被计分 N 次。"""
        bundle = PredictionBundle(
            path="p",
            columns=["id", "value"],
            rows=[{"id": "a", "value": 1}, {"id": "a", "value": 1}],
        )
        with self.assertRaises(ValueError):
            assert_id_alignment(bundle, ["a", "b"])


if __name__ == "__main__":
    unittest.main()
