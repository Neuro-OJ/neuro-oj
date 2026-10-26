# Agent Note: judge Python SDK 单测抖动修复并接入 CI

Status: implemented

## Problem

`noj-judge/sdk/evaluator/noj_evaluator_sdk/tests/test_runner.py` 中的 call
类用例依赖固定 `time.sleep(0.05)` 等待后台线程写出 call 帧；
`test_call_frame_with_timeout_ms` / `test_call_frame_without_timeout_ms`
甚至完全不等待，启动线程后立即读 stdout，本地复现失败率很高（main
上同样可复现）。

失败后还有第二个问题：call 线程是非 daemon 线程，阻塞在 `q.get()`。若线程在
`teardown()` 调用 `runner.close()` **之后**才注册 pending，`close()`
的唤醒落空， 线程永远阻塞，测试进程无法退出（外层 `timeout` 返回 124）。

另外，evaluator / solution 两个 SDK 的 Python 单测从未在 CI 中运行，
上述抖动因此一直未被发现。

## Decision

- `IpcHarness` 新增 `start_call()`（daemon 线程跑 `runner.call`）与
  `wait_for_frames(count)`（轮询 stdout 直到帧数达标，超时 2s 抛断言）， 所有
  call 用例与 capability 用例统一改用轮询，删除全部固定 sleep。 `_run_call`
  在启动线程**之前**记录已有帧数，避免辅助函数自身产生竞态。
- `teardown()` 在 `runner.close()` 后循环 `shutdown_pending()` 并 join call
  线程（上限 2s），覆盖"close 之后才注册 pending"的时序。
- CI `judge-check` job 新增 Python 3.12 + 两个 SDK 单测 step。tests 目录无
  `__init__.py`，`unittest discover` 无法发现，故在 shell 中把 `test_*.py`
  展开为模块名传给 `python -m unittest`；外层 `timeout 300` 兜底。

## Alternatives considered

- 只把线程设为 daemon：进程能退出，但失败用例的根因（固定 sleep 等帧）仍在。
- 在 `SolutionRunner.call()` 注册 pending 后再检查 `_closed`：修复的是生产代码
  中 close 与 call 并发的边角竞态，超出本次"测试抖动"范围，留待单独评估。
- 给 tests 目录补 `__init__.py` 以使用 discover：会改变现有
  `sys.path.insert(0, sys.path[0] + "/..")` 等导入假设，收益不大。
- 放到独立 job：需重复 checkout；挂在已有 `judge-check` 上开销仅数十秒。

## Consequences

- 本地 evaluator / solution 全量单测连续 10 次通过且正常退出；`test_runner`
  单独连续 40 次无失败。
- 之后修改 `noj-judge/**`（含 SDK）的 PR 都会运行 SDK 单测。
- 新增测试文件只要命名为 `test_*.py` 即被 CI 自动纳入。
