## 1. InFlightTracker 纯逻辑模块

- [ ] 1.1 创建 `noj-judge/src/dual/tracker.rs`：`WaitingSide` 枚举（Evaluator/Solution）、`InFlightTracker`（`inflight: HashMap<call_id, (deadline, waiting)>`、`cap_timeouts: HashMap<name, timeout_ms>`、`default_call_timeout_ms`），方法 `on_call_frame` / `on_cap_reg_frame` / `on_capability_frame` / `resolve_response` / `expire_now` / `next_deadline` / `is_empty`，超时解析规则（正整数生效、缺省/非法回退默认）
- [ ] 1.2 在 `noj-judge/src/dual/mod.rs` 声明 `pub mod tracker;`
- [ ] 1.3 编写单元测试（11 个，见 `docs/superpowers/plans/2026-08-04-call-timeout-per-call.md` Task 1）：缺省/显式/非法超时回退、无 id 返回 None、cap_reg 注册/覆盖/删除、capability 命中映射与回退、响应命中移除、未知 id false、expire 摘除与方向、并发独立 deadline、next_deadline 取最小
- [ ] 1.4 运行 `cargo test --lib dual::tracker` 与 `cargo clippy --lib` 通过后 `cargo fmt` 并提交（feat(judge): 新增调用级超时追踪器 InFlightTracker）

## 2. Evaluator SDK 扩展

- [ ] 2.1 `runner.py` 的 `SolutionRunner.call(fn, *args, timeout_ms=None)`：校验 timeout_ms（None 或正整数，否则 `ValueError`）；指定时 call 帧带 `timeout_ms` 字段，缺省不带
- [ ] 2.2 `capability.py` 的 `register_capability(name, handler, timeout_ms=None)`：校验 timeout_ms；注册后写一次性 `{"type":"cap_reg","name":...,"timeout_ms":...}` 帧到 stdout（线程安全，`_OUT_LOCK`；timeout_ms=None 时帧不含该字段）
- [ ] 2.3 在 `tests/test_runner.py` 追加单测（7 个）：call 帧含/不含 timeout_ms、非法值抛 ValueError 且不发帧、cap_reg 帧发出/缺字段/非法值抛错
- [ ] 2.4 运行 `python3 -m unittest noj_evaluator_sdk.tests.test_runner -v` 全部通过后提交（feat(judge): Evaluator SDK 支持调用级 timeout_ms 与 cap_reg 上报）

## 3. dual 主循环接入调用级超时

- [ ] 3.1 改造 `handle_eval_chunk`（新增 `sol_input` 与 `tracker` 参数）：call 帧登记后原样转发、cap_reg 帧仅更新映射不转发、result/error 帧按 `resolve_response` 命中判定转发或丢弃
- [ ] 3.2 改造 `handle_sol_chunk`（新增 `tracker` 参数）：capability 帧查映射登记后转发、result/error 帧按 id 判定转发或丢弃
- [ ] 3.3 改造 `run_dual_loop`：`_call_timeout_ms` 改名为 `default_call_timeout_ms` 并传入 `InFlightTracker::new`；两阶段 `tokio::select!` 增加 `sleep_until(最早 deadline)` 分支，到期按 `WaitingSide` 向对应方向写 `{"type":"error","id":...,"code":"Timeout","message":"call timeout"}` 错误帧并移除
- [ ] 3.4 新增 `write_timeout_frame(writer, id)` 辅助函数；同步更新 `evaluate_dual` 调用处与 `mod_test_helpers` 两个 probe 函数签名
- [ ] 3.5 在 mod.rs tests 追加测试（2 个）：call 帧被追踪且原样转发（含 timeout_ms 字段）、cap_reg 帧不转发
- [ ] 3.6 运行 `cargo test --all-targets` 与 `cargo clippy --lib` 通过后 `cargo fmt` 并提交（feat(judge): dual 主循环接入调用级超时）

## 4. judge E2E（真实容器）

- [ ] 4.1 在 `tests/e2e_dual_container.rs` 新增 `dual_call_timeout_fallback_to_problem_default`（`#[ignore]` + `#[serial_test::serial]`）：evaluator 不传 timeout_ms、题目级 100ms、solution 睡 300ms → 断言 `SolutionTimeoutError` 用例被记录、评测最终 Accepted
- [ ] 4.2 新增 `dual_call_timeout_per_call_concurrent`：两线程并发 call（50ms 超时慢调用 + 5000ms 正常调用）→ 各自独立生效，慢调用超时、快调用返回 42
- [ ] 4.3 运行 `cargo check --tests` 编译通过；有 Docker 时 `NOJ_RUN_E2E=1 cargo test --test e2e_dual_container dual_call_timeout -- --ignored --nocapture` 通过后提交（test(judge): 调用级超时 E2E）

## 5. noj-tests 全链路 E2E

- [ ] 5.1 新建 `noj-tests/e2e/26_call_timeout.test.ts`（参照 15_dual_container_judge.test.ts 模式）：用例 A 调用级 timeout_ms 生效（慢调用记为 SolutionTimeoutError、评测继续 Accepted）、用例 B 缺省回退题目级 call_timeout_ms
- [ ] 5.2 运行 `cd noj-tests && deno task test --filter call_timeout` 通过（无完整评测栈时至少 `deno check` 通过），`deno fmt` 后提交（test(core,judge): 调用级超时全链路 E2E）

## 6. 文档与注释同步

- [ ] 6.1 `noj-docs/docs/problemsetters/evaluator-sdk.md`：`runner.call(..., timeout_ms=None)` 签名与缺省回退说明、`register_capability(..., timeout_ms=None)` 默认值语义、`SolutionTimeoutError` 用法
- [ ] 6.2 `noj-docs/docs/problemsetters/rpc.md`：call 帧 `timeout_ms` 可选字段（仅 judge 计时）、`cap_reg` 帧（私有协议不转发）、错误来源表 `CallTimeout` 更新、缺省回退规则
- [ ] 6.3 `noj-docs/docs/problemsetters/web-editor.md`：`call_timeout_ms` 语义 = 题目级默认值，`runner.call(..., timeout_ms)` 可按调用覆盖
- [ ] 6.4 `noj-core/src/types/index.ts` 与 `src/services/problems-types.ts`：注释同步（call_timeout_ms 默认值角色；校验不变）
- [ ] 6.5 运行 `cd noj-core && deno fmt --check` 相关文件后提交（docs(root,core): 同步调用级超时文档与注释）
