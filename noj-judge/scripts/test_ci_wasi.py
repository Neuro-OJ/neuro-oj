"""验证 WASI 分片仅构建所需示例，且编译失败/跨进程输出不一致仍阻断验收。"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = {
    "wasi": "oi_wasi_acceptance",
    "standard": "oi_standard_acceptance",
    "compat": "oi_wasi_v2_acceptance",
}


class WasiSchedulingTests(unittest.TestCase):
    def run_check(self, shard, failure=""):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / "noj-judge/scripts"
            scripts.mkdir(parents=True)
            script = scripts / "check-oi-wasi-toolchain.sh"
            shutil.copyfile(ROOT / "noj-judge/scripts" / script.name, script)
            sdk = root / "sdk"
            sdk.mkdir()
            cargo = root / "cargo"
            cargo.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, pathlib, sys\n"
                "args = sys.argv[1:]\n"
                "root = pathlib.Path(os.environ['TEST_ROOT'])\n"
                "(root / 'build.json').write_text(json.dumps(args))\n"
                "if os.environ['FAILURE'] == 'build': sys.exit(1)\n"
                "names = json.loads(os.environ['EXAMPLES']) if '--examples' in args else [args[args.index('--example')+1]]\n"
                "output = pathlib.Path('target/debug/examples')\n"
                "output.mkdir(parents=True)\n"
                "for name in names:\n"
                "    binary = output / name\n"
                "    if os.environ['FAILURE'] == 'mismatch':\n"
                "        body = '#!/usr/bin/env python3\\nimport os, sys\\nsys.stdout.write(str(os.getpid()) + \"\\\\n\")\\n'\n"
                "    else:\n"
                "        body = '#!/usr/bin/env python3\\nimport sys\\nsys.stdout.write(\"{}\\\\n\")\\n'\n"
                "    binary.write_text(body)\n"
                "    binary.chmod(0o755)\n"
            )
            cargo.chmod(0o755)
            result = subprocess.run(
                ["bash", str(script), str(sdk), shard],
                env={
                    **os.environ,
                    "PATH": f"{root}:{os.environ['PATH']}",
                    "TEST_ROOT": str(root),
                    "FAILURE": failure,
                    "EXAMPLES": json.dumps(list(EXAMPLES.values())),
                    "NOJ_WASI_OPT_DEPS": "1",
                },
                capture_output=True,
                text=True,
                timeout=15,
            )
            build = root / "build.json"
            return result, json.loads(build.read_text()) if build.exists() else None

    def test_each_shard_builds_and_executes_its_example(self):
        for shard, example in EXAMPLES.items():
            with self.subTest(shard=shard):
                result, args = self.run_check(shard)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(args[:4], ["build", "--locked", "--example", example])
                self.assertEqual(args[4:], ["--config", 'profile.dev.package."*".opt-level=3'])

    def test_all_preserves_full_acceptance(self):
        result, args = self.run_check("all")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--examples", args)

    def test_build_failure_stops_acceptance(self):
        result, _ = self.run_check("standard", "build")
        self.assertNotEqual(result.returncode, 0)

    def test_cross_process_mismatch_still_fails(self):
        for shard in ("standard", "compat", "all"):
            with self.subTest(shard=shard):
                result, _ = self.run_check(shard, "mismatch")
                self.assertNotEqual(result.returncode, 0)

    def test_unknown_shard_fails_before_build(self):
        result, args = self.run_check("unknown")
        self.assertEqual(result.returncode, 2)
        self.assertIsNone(args)


if __name__ == "__main__":
    unittest.main()
