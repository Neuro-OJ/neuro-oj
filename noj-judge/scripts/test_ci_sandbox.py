"""执行 CI 的沙箱调度脚本，验证测试发现与每个并行组的失败传播。"""

import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[2]


def sandbox_command():
    workflow = (ROOT / ".github/workflows/e2e.yml").read_text()
    step = workflow.split("      - name: Judge E2E 测试", 1)[1]
    script = step.split("        run: |\n", 1)[1]
    lines = []
    for line in script.splitlines():
        if line.strip() and not line.startswith("          "):
            break
        lines.append(line)
    return textwrap.dedent("\n".join(lines))


class SandboxSchedulingTests(unittest.TestCase):
    def run_schedule(self, failed_target=""):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cargo = root / "cargo"
            cargo.write_text(
                "#!/usr/bin/env python3\n"
                "import os, pathlib, sys\n"
                "args = sys.argv[1:]\n"
                "if args == ['--version']: sys.exit(0)\n"
                "assert args[:2] == ['test', '--locked'], args\n"
                "assert args[2] == '--test', args\n"
                "assert args[4:] == ['--', '--ignored', '--test-threads=1'], args\n"
                "assert os.environ['NOJ_RUN_E2E'] == '1'\n"
                "target = args[3]\n"
                "pathlib.Path(os.environ['TRACE_DIR'], target).touch()\n"
                "sys.exit(1 if target == os.environ['FAILED_TARGET'] else 0)\n"
            )
            cargo.chmod(0o755)
            trace = root / "trace"
            trace.mkdir()
            result = subprocess.run(
                ["bash", "-c", sandbox_command()],
                env={
                    **os.environ,
                    "PATH": f"{root}:{os.environ['PATH']}",
                    "TRACE_DIR": str(trace),
                    "FAILED_TARGET": failed_target,
                },
                capture_output=True,
                text=True,
                timeout=15,
            )
            return result, {path.name for path in trace.iterdir()}

    def test_all_sandbox_targets_execute(self):
        result, executed = self.run_schedule()
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = {path.stem for path in (ROOT / "noj-judge/tests").glob("e2e_*.rs")}
        self.assertEqual(executed, expected)

    def test_each_parallel_group_propagates_failure(self):
        for target in (
            "e2e_docker_basic",
            "e2e_support_package",
            "e2e_dual_container",
            "e2e_solution_ai",
        ):
            with self.subTest(target=target):
                result, executed = self.run_schedule(target)
                self.assertIn(target, executed)
                self.assertNotEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
