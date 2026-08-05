## 1. finalize_outcome 纯函数

- [ ] 1.1 在 `noj-judge/src/dual/mod.rs` 的 `mod tests` 中新增 `test_finalize_outcome_mapping` 表驱动测试（6 断言：Startup/Total × sent_call_timeout ∈ {true,false} → SystemError；None+true → TimeLimitExceeded；None+false → SystemError），`JudgeStatus` 若未导入则在测试内 `use crate::types::JudgeStatus;`
- [ ] 1.2 运行 `cd noj-judge && cargo test finalize_outcome -- --nocapture` 确认失败（编译错误：找不到函数/类型）
- [ ] 1.3 在 `run_dual_loop` 前新增 `enum TimeoutKind { Startup, Total }` 与 `fn finalize_outcome(timed_out: Option<TimeoutKind>, sent_call_timeout: bool) -> JudgeStatus`（规则：timed_out → SystemError；sent_call_timeout → TimeLimitExceeded；否则 SystemError），中文注释说明优先级
- [ ] 1.4 运行 `cd noj-judge && cargo test finalize_outcome -- --nocapture` 确认通过
- [ ] 1.5 提交：`jj describe -m "test(judge): finalize_outcome 状态映射纯函数（issue #202）"`

## 2. run_dual_loop 接入 finalize_outcome

- [ ] 2.1 在 `run_dual_loop` 中 `InFlightTracker::new` 之后新增 `let mut sent_call_timeout = false;`（注释说明仅 WaitingSide::Evaluator 置位）
- [ ] 2.2 阶段 1 启动超时分支：`JudgeResult::timeout` 改为 `JudgeResult::system_error`（output 保留 "evaluator startup timeout"）
- [ ] 2.3 阶段 2 总超时分支：`JudgeResult::timeout` 改为 `JudgeResult::system_error`（output 保留 "evaluator total timeout"）
- [ ] 2.4 两处 in-flight 到期分支的 `WaitingSide::Evaluator` 分支在 `write_timeout_frame` 成功后加 `sent_call_timeout = true;`；`WaitingSide::Solution` 分支不变
- [ ] 2.5 无 RESULT 收尾分支：返回值改为 `match finalize_outcome(None, sent_call_timeout) { JudgeStatus::TimeLimitExceeded => Ok(JudgeResult::timeout(submission_id, &full_output, rejudge_seq)), _ => Ok(JudgeResult::system_error(submission_id, &full_output, rejudge_seq)) }`
- [ ] 2.6 运行 `cd noj-judge && cargo test --lib` 确认全部通过；`cargo fmt --check && cargo clippy --all-targets -- -D warnings` 无警告
- [ ] 2.7 提交：`jj describe -m "fix(judge): evaluator 总超时归 SystemError、CallTimeout 未处理归 TLE（issue #202）"`

## 3. 错误帧 code 统一为 CallTimeout

- [ ] 3.1 修改 `noj-judge/sdk/evaluator/noj_evaluator_sdk/tests/test_runner.py` 第 227 行附近错误帧 code 断言 `"Timeout"` → `"CallTimeout"`
- [ ] 3.2 运行 `cd noj-judge/sdk/evaluator && python3 -m unittest discover -s tests -v` 确认失败（SDK 仍匹配旧 code）
- [ ] 3.3 `noj-judge/src/dual/mod.rs` `write_timeout_frame`：`"code": "Timeout"` → `"code": "CallTimeout"`
- [ ] 3.4 `noj-judge/sdk/evaluator/noj_evaluator_sdk/runner.py` 第 319 行：`if code == "Timeout":` → `if code == "CallTimeout":`（不保留旧兼容分支）
- [ ] 3.5 运行 SDK 单测（unittest discover）与 `cd noj-judge && cargo test --lib` 确认通过
- [ ] 3.6 更新 `noj-judge/tests/e2e_dual_container.rs` `dual_capability_timeout_per_call` 中 code 断言 `"Timeout"` → `"CallTimeout"`
- [ ] 3.7 提交：`jj describe -m "fix(judge,sdk): 超时错误帧 code 统一为 CallTimeout（issue #202）"`

## 4. E2E 三种超时场景测试

- [ ] 4.1 在 `noj-judge/tests/e2e_dual_container.rs` 末尾新增 `dual_evaluator_total_timeout_system_error`：evaluate.py 打印 ready 后死循环、`time_limit_ms: 2000`，断言 `result.status == "SystemError"`（`#[ignore]` + `#[serial_test::serial]` + `is_e2e_enabled()` 守卫）
- [ ] 4.2 运行 `cd noj-judge && NOJ_RUN_E2E=1 cargo test --test e2e_dual_container dual_evaluator_total_timeout_system_error -- --ignored --nocapture` 确认通过
- [ ] 4.3 新增 `dual_solution_timeout_unhandled_tle`：evaluator 调 `runner.call('sleep_solution')` 不捕获（异常冒泡崩溃）、`call_timeout_ms: 100`、solution sleep 300ms，断言 `result.status == "TimeLimitExceeded"`
- [ ] 4.4 运行同上命令（换测试名）确认通过
- [ ] 4.5 新增 `dual_solution_timeout_handled_wrong_answer`：evaluator `try/except SolutionTimeoutError` 后 `result.wrong_answer(...)`，断言 `result.status == "WrongAnswer"`
- [ ] 4.6 运行同上命令（换测试名）确认通过
- [ ] 4.7 全量回归：`cd noj-judge && NOJ_RUN_E2E=1 cargo test --test e2e_dual_container -- --ignored`（既有测试 + 新增 3 个全部通过）
- [ ] 4.8 提交：`jj describe -m "test(judge): 补 evaluator 超时/CallTimeout 未处理/被捕获三种 E2E（issue #202）"`

## 5. 文档五处更新

- [ ] 5.1 `noj-docs/docs/reference/result-status.md`：TimeLimitExceeded 一节改为区分「单次调用超时未捕获 → TLE」与「整体流程超时 → SystemError」；SystemError 列表补充「evaluator 整体执行超过 time_limit_ms」与「evaluator 启动超时」
- [ ] 5.2 `noj-docs/docs/problemsetters/rpc.md`：错误来源表 CallTimeout 一行补充「该错误由 Judge 直接注入；若 evaluator 未捕获（evaluate.py 异常退出、无 ---RESULT---），最终状态为 TimeLimitExceeded」
- [ ] 5.3 `noj-docs/docs/problemsetters/judge-model.md`：新增「超时与状态映射」小节（三层映射表：整体超时→SystemError / 调用超时未捕获→TLE / 捕获→evaluator 决定）
- [ ] 5.4 `noj-docs/docs/problemsetters/web-editor.md`：运行时配置两层超时语义补充（time_limit_ms→SystemError；call_timeout_ms 未捕获→TLE）
- [ ] 5.5 `noj-docs/docs/intro/what-is-noj.md`：时空限制一节单次调用超时描述后补充状态映射
- [ ] 5.6 人工检查五处与设计文档状态映射表一致、无 TBD/TODO
- [ ] 5.7 提交：`jj describe -m "docs: 明确 evaluator/solution 超时状态映射（issue #202）"`
