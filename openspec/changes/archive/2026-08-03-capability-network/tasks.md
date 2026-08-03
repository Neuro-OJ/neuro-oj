# capability-network 实施任务

## 1. noj-judge 网络层与帧转发

- [x] 1.1 `src/types.rs`：`EvaluatorRuntime` 增加 `network: Option<EvaluatorNetwork>`（`#[serde(default)]`，`EvaluatorNetwork { enabled: bool }`，缺省 `None` = 无网）
- [x] 1.2 `src/sandbox/host_config.rs`：`build_host_config` 增加 `network_mode: &str` 参数（`"none"` / `"bridge"`），更新全部调用方与单元测试
- [x] 1.3 `src/dual/container.rs`：`create_evaluator` 接收 `network_enabled: bool` 并传入 host_config（solution 恒 `none`）
- [x] 1.4 `src/dual/protocol.rs`：增加 `FRAME_CAPABILITY: &str = "capability"` 常量
- [x] 1.5 `src/dual/mod.rs`：`handle_eval_chunk` 新增转发 evaluator stdout 的 `result` / `error` 帧到 solution stdin（capability 响应）；保持 `call` 帧转发与 `---RESULT---` 行为不变
- [x] 1.6 单元测试：host_config 网络参数、handle_eval_chunk 新转发分支（result/error 转发、普通文本不转发）；`cargo fmt` + `cargo clippy` 通过

## 2. SDK：solution 侧

- [x] 2.1 `sdk/solution/noj_solution_sdk/capability.py`（新增）：`call_capability(name, *args)` —— 帧大小校验、发 `capability` 帧、按 id 匹配 result/error、异常映射（`CapabilityNotFoundError` 等）
- [x] 2.2 `sdk/solution/noj_solution_sdk/host.py`：重构为 reader 线程 + 单 worker 队列（call 帧投递队列顺序执行；result/error 帧按 id 匹配 pending；ready 时序、entry 加载、error 码行为不变）
- [x] 2.3 `sdk/solution/noj_solution_sdk/__init__.py`：导出 `call_capability` 与新增错误类
- [x] 2.4 SDK 测试：`test_host.py` 增补 call_capability 用例（成功/NotFound/参数拒绝）+ 既有行为回归

## 3. SDK：evaluator 侧

- [x] 3.1 `sdk/evaluator/noj_evaluator_sdk/capability.py`（新增）：`register_capability(name, handler)` + 注册表（重复注册覆盖）
- [x] 3.2 `sdk/evaluator/noj_evaluator_sdk/runner.py`：reader 线程识别 `capability` 帧 → 查注册表 → 同步执行 handler → 写 result/error 帧（未注册 → `NotFound`）
- [x] 3.3 `sdk/evaluator/noj_evaluator_sdk/__init__.py`：导出 `register_capability`
- [x] 3.4 SDK 测试：`test_runner.py` 增补 register_capability 用例（成功/异常/NotFound/重复注册）

## 4. noj-core 类型与校验

- [x] 4.1 `src/types/index.ts`：`EvaluatorRuntime` 增加可选 `network?: { enabled: boolean }`
- [x] 4.2 `src/services/problems-types.ts`：`validateRuntimeConfig` 校验 network（可选对象、`enabled` 必须为布尔；非法返回 `invalid_structure` 400）
- [x] 4.3 noj-core 测试：network 缺省 / 合法 / 非法值校验用例

## 5. noj-ui 题目编辑表单

- [x] 5.1 `noj-ui/components/editor/ProblemEditor.vue`：新增「evaluator 联网」开关（默认关），payload 组装 `evaluator.network` 与编辑回显
- [x] 5.2 `deno fmt` + `deno lint` 通过

## 6. E2E 测试

- [x] 6.1 judge E2E 新 binary `tests/e2e_network_capability.rs`（`#[ignore]` + `NOJ_RUN_E2E=1` + `#[serial_test::serial]`）：evaluator 开启联网后容器内 DNS/TCP 连通；solution 无网断言
- [x] 6.2 同 binary：call_capability 全链路（注册 handler 返回正确值；未注册 → NotFound；handler 异常 → error 帧）
- [x] 6.3 注册到 `Cargo.toml`（[[test]] 条目）并本地跑通

## 7. 文档（noj-docs）

- [x] 7.1 做题人：`docs/users/` 新增「使用 capability」页面（`call_capability` 用法、类型约束、错误语义、示例），注册到 `.vitepress` 侧栏
- [x] 7.2 出题人：`docs/problemsetters/solution-sdk.md` 以正式 API 替换 call_capability 占位表述
- [x] 7.3 出题人：`docs/problemsetters/evaluator-sdk.md` 增补 `register_capability` 用法
- [x] 7.4 出题人：新增「如何提供受限网络能力」最佳实践（封装精确函数如 `request_llm_completion(prompt)` 而非 `fetch_url(url)`；参数校验、禁通用转发、禁访元数据/内网、重定向陷阱、参考示例、未来代理兜底）
- [x] 7.5 `docs/intro/what-is-noj.md` / `docs/reference/glossary.md` 更新（移除"规划中"占位）

## 8. 回归与归档

- [x] 8.1 全量回归：`cargo test`（judge 单元）、SDK 测试、`deno task test`（core）、judge E2E、`deno fmt`/`deno lint`/`cargo clippy`
- [x] 8.2 `/opsx:sync` 同步 delta specs 到主规范；`/opsx:archive` 归档（`YYYY-MM-DD-capability-network`）
