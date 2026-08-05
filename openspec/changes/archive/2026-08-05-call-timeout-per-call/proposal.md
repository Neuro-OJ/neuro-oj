## Why

当前 `call_timeout_ms` 是题目 `runtime_config.solution` 的固定值，同一道题的所有 `runner.call()` 共用同一个超时。不同用例耗时差异可能很大（简单用例毫秒级、复杂推理用例数十秒），且大模型能力评测中每次调用耗时波动大：固定值要么频繁误杀、要么整体放大风险窗口。需要把超时控制下沉到单次调用粒度。

## What Changes

- Evaluator SDK `runner.call(fn, *args, timeout_ms=None)`：每次调用可**按调用指定超时**；`timeout_ms` 缺省/非法时由 Judge Worker 回退到题目级 `runtime_config.solution.call_timeout_ms`（向后兼容，题目级配置保留为默认值）。
- RPC call 帧增加可选 `timeout_ms` 字段（正整数生效；该字段仅供 Judge 计时，Solution Host 执行逻辑不感知）。
- Judge Worker 执行层支持调用级超时：in-flight 追踪 + 参数化 tokio 超时；超时向等待方写 `code="Timeout"` 错误帧，Evaluator 侧抛既有 `SolutionTimeoutError`，可捕获记为失败用例继续评测；迟到的响应帧按 id 丢弃。
- capability 反向调用（Solution → Evaluator）同样纳入超时：`register_capability(name, handler, timeout_ms=None)` 注册时配置默认值，经一次性 `cap_reg` 帧上报 Judge，缺省回退题目级默认；Solution 调用侧不指定超时。
- 超时计时起点：Judge 收到帧的时刻（call 帧 / capability 帧）。
- 文档同步：evaluator-sdk.md / rpc.md / web-editor.md 与 core 类型注释。
- **行为变化**：调用级超时首次真正生效——此前用户函数死循环只能靠 Evaluator 总超时（`time_limit_ms`）兜底；此后会被调用级超时打断（记为失败调用，评测继续）。

## Capabilities

### New Capabilities

- `call-timeout-per-call`: 调用级超时能力——Evaluator SDK `runner.call(..., timeout_ms)` 与 `register_capability(..., timeout_ms)` API、call 帧 `timeout_ms` 字段、`cap_reg` 帧协议、Judge Worker in-flight 超时追踪（计时起点、超时错误帧、迟到响应丢弃、题目级默认回退）。

### Modified Capabilities

- `judge-worker`: 「时间层级关系」与「单次调用超时」场景语义更新——单次调用超时受调用级 `timeout_ms` 约束、缺省回退题目级 `call_timeout_ms`；超时后 Judge 向 Evaluator 回 `Timeout` 错误帧并丢弃迟到响应（而非"停止写入通道"）。
- `network-capability`: `register_capability` API 签名增加可选 `timeout_ms`（注册时配置的 capability 调用默认超时，经 `cap_reg` 帧上报 Judge）。
- `problem-runtime-config`: `solution.call_timeout_ms` 角色明确为**调用级超时的题目级默认值**（校验不变：仍为必填正整数）。

## Impact

- **noj-judge**：`src/dual/mod.rs`（run_dual_loop / handle_eval_chunk / handle_sol_chunk 超时感知改造）、新增 `src/dual/tracker.rs`（InFlightTracker 纯逻辑模块）、`src/dual/protocol.rs`（cap_reg 帧常量）；`sdk/evaluator/noj_evaluator_sdk/runner.py`（call 签名）、`capability.py`（register_capability 签名 + cap_reg 帧输出）；`tests/e2e_dual_container.rs`（E2E）。
- **noj-tests**：新增全链路 E2E（调用级超时 + 缺省回退）。
- **noj-core**：`src/types/index.ts` 与 `src/services/problems-types.ts` 注释同步（字段校验不变）。
- **文档**：`noj-docs/docs/problemsetters/{evaluator-sdk,rpc,web-editor}.md`。
- **协议**：call 帧可选字段 `timeout_ms`（向后兼容，不新增协议版本号）；新增 evaluator→judge 私有 `cap_reg` 帧（不转发）。
