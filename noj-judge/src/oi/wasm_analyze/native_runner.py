"""仅在隔离 Docker 中运行的原生 CPU 对照，不用于正式判题。"""
import json
import math
import os
from pathlib import Path
import resource
import subprocess
import time

request = json.loads(Path('/workspace/request.json').read_text())
compiler = 'gcc' if request['language'] == 'c' else 'g++'
source = '/workspace/main.c' if compiler == 'gcc' else '/workspace/main.cc'
version = subprocess.check_output([compiler, '--version'], text=True).splitlines()[0]
compiled = subprocess.run(
    [compiler, '-I/workspace/files', '-O2', '-std=c99' if compiler == 'gcc' else '-std=c++11', source, '-o', '/tmp/main'],
    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15,
)
if compiled.returncode:
    raise RuntimeError('原生对照编译失败: ' + compiled.stderr.decode(errors='replace')[:4096])
rows = []
for limit in request['limits']:
    for repetition in range(request['repeat']):
        run_root = Path('/tmp') / f'run-{limit}-{repetition}'
        run_root.mkdir()
        for name in request['extra_files']:
            target = run_root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((Path('/workspace/files') / name).read_bytes())
        prefix = request['filename']
        if prefix:
            (run_root / (prefix + '.in')).write_bytes(Path('/workspace/input').read_bytes())
        def limits():
            resource.setrlimit(resource.RLIMIT_AS, (request['memory_mb'] * 1048576,) * 2)
            resource.setrlimit(resource.RLIMIT_CPU, (math.ceil(limit / 1000) + 1,) * 2)
            resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1048576,) * 2)
        before = resource.getrusage(resource.RUSAGE_CHILDREN)
        started = time.monotonic()
        with Path('/workspace/input').open('rb') as inp, (run_root / 'stdout').open('wb') as out, (run_root / 'stderr').open('wb') as err:
            proc = subprocess.Popen(['/tmp/main'], stdin=subprocess.DEVNULL if prefix else inp, stdout=out, stderr=err, cwd=run_root, preexec_fn=limits)
            try:
                proc.wait(timeout=max(30, limit / 100))
                interrupted = False
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
                interrupted = True
        after = resource.getrusage(resource.RUSAGE_CHILDREN)
        cpu_ms = (after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime) * 1000
        wall_ms = (time.monotonic() - started) * 1000
        output = run_root / (prefix + '.out') if prefix else run_root / 'stdout'
        expected = Path('/workspace/expected').read_bytes()
        actual = output.read_bytes() if output.exists() else b''
        import hashlib
        verdict = 'SE' if interrupted else 'TLE' if cpu_ms > limit else 'RE' if proc.returncode else 'AC' if (actual == expected if request['strict'] else actual.split() == expected.split()) else 'WA'
        rows.append({'time_limit_ms': limit, 'verdict': verdict, 'cpu_time_ms': cpu_ms, 'wall_time_ms': wall_ms,
                     'output_sha256': hashlib.sha256(actual).hexdigest(), 'return_code': proc.returncode})
print(json.dumps({'compiler': version, 'compiler_flags': ['-O2', '-std=c99' if compiler == 'gcc' else '-std=c++11'],
                  'runs': rows, 'note': '同机隔离运行，CPU 时间是观测值，不作为跨硬件一致性门槛。'}))
