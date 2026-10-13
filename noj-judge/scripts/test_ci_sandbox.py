"""执行 CI 的沙箱调度脚本，验证测试发现与每个并行组的失败传播。"""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[2]


def workflow_command(name, path=".github/workflows/e2e.yml"):
    workflow = (ROOT / path).read_text()
    step = workflow.split(f"- name: {name}", 1)[1]
    script = step.split("run: |\n", 1)[1]
    lines = []
    indent = len(script.splitlines()[0]) - len(script.splitlines()[0].lstrip())
    for line in script.splitlines():
        if line.strip() and len(line) - len(line.lstrip()) < indent:
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
                ["bash", "-c", workflow_command("Judge E2E 测试")],
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

    def run_preparation(self, step, failed_command=""):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for tool in ("cargo", "docker"):
                command = root / tool
                command.write_text(
                    "#!/usr/bin/env python3\n"
                    "import json, os, pathlib, sys, time\n"
                    "tool = pathlib.Path(sys.argv[0]).name\n"
                    "args = sys.argv[1:]\n"
                    "kind = 'compile' if tool == 'cargo' else args[0]\n"
                    "if kind == 'images': sys.exit(0)\n"
                    "trace = pathlib.Path(os.environ['RUNNER_TEMP'])\n"
                    "(trace / (kind + '.json')).write_text(json.dumps(args))\n"
                    "other = {'compile':'build', 'build':'compile', 'compose':'load', 'load':'compose'}[kind]\n"
                    "deadline = time.monotonic() + 3\n"
                    "while not (trace / (other + '.json')).exists():\n"
                    "    if time.monotonic() > deadline: sys.exit(2)\n"
                    "    time.sleep(0.01)\n"
                    "sys.exit(1 if kind == os.environ['FAILED_COMMAND'] else 0)\n"
                )
                command.chmod(0o755)
            images = root / "e2e-images"
            images.mkdir()
            (images / "core.tar").touch()
            composite = step == "加载镜像并启动基础设施"
            result = subprocess.run(
                ["bash", "-c", workflow_command(
                    step,
                    ".github/actions/e2e-domain/action.yml" if composite
                    else ".github/workflows/e2e.yml",
                )],
                cwd=ROOT / "noj-judge",
                env={
                    **os.environ,
                    "PATH": f"{root}:{os.environ['PATH']}",
                    "RUNNER_TEMP": str(root),
                    "COMPOSE_PROJECT_NAME": "ci-test",
                    "FAILED_COMMAND": failed_command,
                },
                capture_output=True,
                text=True,
                timeout=15,
            )
            traces = {path.stem: json.loads(path.read_text()) for path in root.glob("*.json")}
            return result, traces

    def test_sandbox_preparation_overlaps_and_builds_all_e2e_targets(self):
        result, traces = self.run_preparation("并行编译沙箱测试与构建 OI 镜像")
        self.assertEqual(result.returncode, 0, result.stderr)
        args = traces["compile"]
        self.assertEqual(args[:2], ["build", "--locked"])
        self.assertEqual(set(args[2::2]), {"--test"})
        self.assertEqual(set(args[3::2]), {
            path.stem for path in (ROOT / "noj-judge/tests").glob("e2e_*.rs")
        })

    def test_infrastructure_starts_during_image_load(self):
        result, traces = self.run_preparation("加载镜像并启动基础设施")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(traces), {"compose", "load"})
        self.assertEqual(traces["compose"][-5:], ["postgres", "redis", "minio", "minio-init", "llm-mock"])

    def test_each_preparation_failure_propagates(self):
        for step, commands in (
            ("并行编译沙箱测试与构建 OI 镜像", ("compile", "build")),
            ("加载镜像并启动基础设施", ("compose", "load")),
        ):
            for command in commands:
                with self.subTest(command=command):
                    result, _ = self.run_preparation(step, command)
                    self.assertNotEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
