## Why

当前评测有两层超时（evaluator 整体 `time_limit_ms` 与单次调用 `call_timeout_ms`），但超时后的最终状态判定不明确且与预期语义不符：evaluator 总超时当前落成 `TimeLimitExceeded`（应为 `SystemError`——评测流程未正常完成，做题人不可通过改代码解决）；solution 调用超时未处理导致 evaluate.py 崩溃时落成 `SystemError`（应为 `TimeLimitExceeded`——用户代码慢是根因）。文档（result-status.md / rpc.md / judge-model.md 等）均未明确这些映射。

## What Changes

- evaluator 总超时（启动超时与整体执行超过 `time_limit_ms`）→ Judge Worker 强制终止评测，最终状态统一为 **SystemError**
- solution 单次调用超时（`call_timeout_ms`）→ Judge 向 evaluator 注入 `CallTimeout` 错误帧；若 evaluator 未捕获（无 `---RESULT---` 退出）→ 最终状态 **TimeLimitExceeded**；被捕获则状态由 evaluator 决定（语义不变）
- 错误帧 `code` 从 `"Timeout"` 统一为 **`"CallTimeout"`**（judge 发送端 + SDK 匹配端 + 测试断言），不保留旧 code 兼容
- 新增纯函数 `finalize_outcome` 集中收尾判定（优先级：总超时 > CallTimeout 归因），配套单测与 E2E 三种场景测试
- 文档五处同步更新（result-status / rpc / judge-model / web-editor / what-is-noj）

## Capabilities

### New Capabilities

（无——超时与状态映射属于既有 judge-worker 能力的修正）

### Modified Capabilities

- `judge-worker`: 「单次调用超时」场景错误帧 code 改为 `CallTimeout`；「Evaluator 总时间超时」场景最终状态由 `TimeLimitExceeded` 改为 `SystemError`；新增「CallTimeout 未处理 → TLE」与「启动超时 → SystemError」场景；错误帧 code 枚举 `Timeout` 改为 `CallTimeout`

## Impact

- `noj-judge/src/dual/mod.rs`：`run_dual_loop` 三个收尾分支 + `write_timeout_frame` + 新增 `finalize_outcome` / `TimeoutKind`（核心改动）
- `noj-judge/sdk/evaluator/noj_evaluator_sdk/runner.py`：`_handle_response` 错误码匹配
- 测试：`noj-judge/src/dual/mod.rs` 单测、`noj-judge/tests/e2e_dual_container.rs`（3 个新 E2E + 1 处断言更新）、SDK `tests/test_runner.py` 断言更新
- 文档：`noj-docs/docs/{reference/result-status.md, problemsetters/rpc.md, problemsetters/judge-model.md, problemsetters/web-editor.md, intro/what-is-noj.md}`
- 无依赖变更；noj-core / noj-ui 不受影响
