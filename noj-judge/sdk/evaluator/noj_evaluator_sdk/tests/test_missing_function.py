"""
noj_evaluator_sdk 单测 —— 选手未定义函数（NotFound）兜底判 0 分。

用子进程跑真实 evaluate.py 形态的脚本：父进程扮演 judge/host，读取 call 帧后
回 NotFound 错误帧，断言子进程 stdout 中的 `---RESULT---` 行为。
"""

import json
import os
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path

SDK_ROOT = Path(__file__).resolve().parents[2]
COMMON_ROOT = SDK_ROOT.parent / "common"


def _run_evaluator(
    script: str, reason: "str | None" = "not_registered"
) -> tuple[int, str, str]:
    """启动 evaluator 脚本，对其首个 call 帧回 NotFound，返回 (退出码, stdout, stderr)。

    `reason` 为 host 帧中的细分原因；None 模拟旧版 solution 镜像（无该字段）。
    """
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([str(SDK_ROOT), str(COMMON_ROOT)])
    proc = subprocess.Popen(
        [sys.executable, "-c", textwrap.dedent(script)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    assert proc.stdout is not None and proc.stdin is not None
    # 跳过 call 帧之前的非协议输出（如先写出的 `---RESULT---`）
    first = ""
    while True:
        line = proc.stdout.readline()
        assert line, "evaluator 未写出 call 帧"
        first += line
        if line.startswith("{") and json.loads(line).get("type") == "call":
            frame = json.loads(line)
            break
    reply = {
        "type": "error",
        "id": frame["id"],
        "code": "NotFound",
        "message": f"function {frame['fn']!r} not registered",
    }
    if reason is not None:
        reply["reason"] = reason
    proc.stdin.write(json.dumps(reply) + "\n")
    proc.stdin.flush()
    try:
        rest, err = proc.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        raise
    return proc.returncode, first + rest, err


def _result_payloads(stdout: str) -> list[dict]:
    lines = stdout.splitlines()
    return [
        json.loads(lines[i + 1])
        for i, line in enumerate(lines)
        if line == "---RESULT---" and i + 1 < len(lines)
    ]


class TestMissingFunctionAsZero(unittest.TestCase):
    def test_uncaught_not_found_writes_zero_result(self):
        """evaluate.py 未捕获 NotFoundError → SDK 写出 0 分结果，traceback 仍在 stderr。"""
        code, out, err = _run_evaluator(
            """
            from noj_evaluator_sdk import SolutionRunner
            runner = SolutionRunner()
            runner.call("solve", 1, 2)
            """
        )
        payloads = _result_payloads(out)
        self.assertEqual(len(payloads), 1, out)
        self.assertEqual(payloads[0]["score"], 0)
        self.assertEqual(payloads[0]["details"]["message"], "未定义函数 solve")
        self.assertEqual(payloads[0]["details"]["error_code"], "function_not_found")
        self.assertEqual(payloads[0]["details"]["function"], "solve")
        self.assertNotEqual(code, 0)
        self.assertIn("NotFoundError", err)

    def test_reraised_not_found_writes_zero_result(self):
        """捕获后原样 raise（如样例 1001 的 except Exception: raise）同样兜底。"""
        code, out, _ = _run_evaluator(
            """
            from noj_evaluator_sdk.runner import SolutionRunner
            runner = SolutionRunner()
            try:
                runner.call("get_config")
            except Exception:
                raise
            """
        )
        payloads = _result_payloads(out)
        self.assertEqual(len(payloads), 1, out)
        self.assertEqual(payloads[0]["details"]["message"], "未定义函数 get_config")

    def test_caught_not_found_keeps_evaluator_result(self):
        """evaluate.py 自行捕获并写结果时，SDK 不追加第二个 RESULT。"""
        code, out, _ = _run_evaluator(
            """
            from noj_evaluator_sdk import NotFoundError, SolutionRunner, result
            runner = SolutionRunner()
            try:
                runner.call("solve")
            except NotFoundError:
                result.wrong_answer(score=0, message="自定义说明")
            """
        )
        payloads = _result_payloads(out)
        self.assertEqual(code, 0)
        self.assertEqual(len(payloads), 1, out)
        self.assertEqual(payloads[0]["details"]["message"], "自定义说明")

    def test_result_already_written_is_not_duplicated(self):
        """结果已写出后才出现未捕获 NotFoundError，不重复写 RESULT。"""
        _, out, _ = _run_evaluator(
            """
            from noj_evaluator_sdk import SolutionRunner, result
            runner = SolutionRunner()
            result.accept(score=50)
            runner.call("solve")
            """
        )
        payloads = _result_payloads(out)
        self.assertEqual(len(payloads), 1, out)
        self.assertEqual(payloads[0]["score"], 5000)

    def test_opt_out_keeps_platform_error_behavior(self):
        """missing_function_as_zero=False：不写 RESULT（judge 归为平台错误）。"""
        code, out, err = _run_evaluator(
            """
            from noj_evaluator_sdk import SolutionRunner
            runner = SolutionRunner(missing_function_as_zero=False)
            runner.call("solve")
            """
        )
        self.assertEqual(_result_payloads(out), [])
        self.assertNotEqual(code, 0)
        self.assertIn("NotFoundError", err)

    def test_entry_load_failure_keeps_platform_error(self):
        """entry 加载失败（语法错误）导致的 NotFound 不判 0 分。"""
        code, out, err = _run_evaluator(
            """
            from noj_evaluator_sdk import SolutionRunner
            runner = SolutionRunner()
            runner.call("solve")
            """,
            reason="entry_load_failed",
        )
        self.assertEqual(_result_payloads(out), [])
        self.assertNotEqual(code, 0)
        self.assertIn("NotFoundError", err)

    def test_legacy_host_without_reason_keeps_platform_error(self):
        """旧版 solution 镜像（NotFound 帧无 reason）保持旧行为，混跑安全。"""
        _, out, _ = _run_evaluator(
            """
            from noj_evaluator_sdk import SolutionRunner
            runner = SolutionRunner()
            runner.call("solve")
            """,
            reason=None,
        )
        self.assertEqual(_result_payloads(out), [])

    def test_other_uncaught_errors_do_not_write_result(self):
        """非 NotFound 的未捕获异常保持原行为（无 RESULT）。"""
        _, out, _ = _run_evaluator(
            """
            from noj_evaluator_sdk import SolutionRunner
            runner = SolutionRunner()
            try:
                runner.call("solve")
            except Exception:
                pass
            raise RuntimeError("evaluator 自身缺陷")
            """
        )
        self.assertEqual(_result_payloads(out), [])


if __name__ == "__main__":
    unittest.main()
