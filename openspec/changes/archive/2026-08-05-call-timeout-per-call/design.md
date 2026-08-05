## Context

当前 `call_timeout_ms` 是题目 `runtime_config.solution` 的固定值，同一道题所有 `runner.call()` 共用同一超时。现状的关键事实：

- `noj-judge/src/dual/mod.rs` 的 `run_dual_loop` 接收 `_call_timeout_ms` 参数（下划线前缀），**实际未使用**——judge 仅双向透明转发 NDJSON 帧，调用级超时当前完全未实现；用户函数死循环只能靠 Evaluator 总超时（`time_limit_ms`）兜底。
- Evaluator SDK `runner.call(fn, *args)` 无超时参数，SDK 阻塞等响应（注释明确"超时由 judge 端 call_timeout_ms 控制"）；`SolutionTimeoutError`（错误码 `Timeout`）已存在但 judge 从不生成。
- Solution Host（`noj_solution_sdk.host`）单 worker 顺序执行 call 帧；capability handler 在 evaluator runner 的 reader 线程同步执行。
- 协议无版本字段；call 帧 `{type, id, fn, args}`，capability 帧 `{type:"capability", id, name, args}`。

约束：向后兼容（旧 SDK / 旧题目零改动）、题目级 `call_timeout_ms` 保留为默认值、Evaluator `time_limit_ms` 保持外层兜底。

## Goals / Non-Goals

**Goals:**

- Evaluator SDK `runner.call(..., timeout_ms=None)` 按调用指定超时；缺省/非法回退题目级默认。
- capability 调用采用 `register_capability(..., timeout_ms=None)` 注册时配置的默认超时（经一次性 `cap_reg` 帧上报 judge）。
- Judge Worker 以 in-flight 追踪 + 参数化 tokio 超时执行调用级超时；超时写 `code="Timeout"` 错误帧，迟到响应按 id 丢弃。
- 行为统一：`runner.call` 与 capability 走同一套 in-flight 机制；计时起点均为 judge 收到帧的时刻。

**Non-Goals:**

- Solution 侧 `call_capability(..., timeout_ms=...)` 调用级指定超时（用户已明确：采用注册时配置的默认值）。
- `runner.restart()` 超时（保持现状）。
- 协议版本字段（可选字段天然兼容）。
- Solution Host 侧超时逻辑（host 无需感知；无法中断的 Python 线程由 judge 计时 + 迟到响应丢弃兜底）。
- 用户函数执行中断（Python 线程无法强杀；超时后 host 存活继续执行，结果被丢弃）。

## Decisions

### D1: 计时起点 = judge 收到帧的时刻（A 方案）

从 judge 收到 Evaluator call 帧（或 Solution capability 帧）起算超时，语义 = 调用方等待本次调用的总时间。由于 Solution Host 单 worker 顺序执行，并发 call 排队时间计入超时——排队过久触发的超时同样记为失败用例（`SolutionTimeoutError`），评测继续，不中断。

- 备选 B（从转发给 host 起算，排队不计）：需记录转发时刻，且 evaluator 可能无限期排队；否决。
- 备选 C（host 回执"开始执行"起算）：需新增协议回执帧，复杂度过高；否决。

### D2: judge 侧 in-flight 追踪（方案 1），非 SDK 侧超时

新建纯逻辑模块 `noj-judge/src/dual/tracker.rs`：`InFlightTracker` 维护 `inflight: HashMap<call_id, (deadline, waiting_side)>`、`cap_timeouts: HashMap<name, timeout_ms>`、`default_call_timeout_ms`。主循环 `tokio::select!` 增加 `sleep_until(最早 deadline)` 分支，到期向等待方写 Timeout 错误帧并移除。

- 备选：每 call 独立 tokio task —— 多 task 竞争同一 stdout 流需 mpsc 分发层，与现有单循环 select 结构冲突大；否决。
- 备选：SDK 侧 `q.get(timeout=...)` —— 与 issue 明确要求（judge 侧参数化 tokio 超时、RPC 帧带 timeout_ms）不符，judge 无超时日志/监控；否决。

### D3: timeout_ms 为 call 帧可选字段，天然向后兼容

`timeout_ms` 正整数生效，缺省/非正整数回退题目级默认。旧 SDK 不发送该字段 → 旧行为不变。Judge 转发给 host 的帧**原样透传**（host 只读 id/fn/args，忽略多余字段，host.py 零改动）。

### D4: capability 默认超时经 cap_reg 帧上报

`register_capability(name, handler, timeout_ms=None)` 时 SDK 写一次性 `{"type":"cap_reg","name":...,"timeout_ms":...}` 帧到 stdout；judge 更新映射（缺省 → 删除映射回退默认）。`cap_reg` 是 evaluator→judge 私有协议，**不转发**给 Solution Host。`classify_line`（protocol.rs）已把含 `type` 字段的 JSON 归为 Frame，解析层无需改动。

### D5: 错误语义沿用既有错误类型

超时错误帧 `{"type":"error","id":...,"code":"Timeout","message":"..."}` → Evaluator SDK 抛既有 `SolutionTimeoutError`（errors.py 已存在）。capability 方向：solution SDK 收到同构错误帧（其 pending 尚在，正常分发抛错）。SDK 侧校验：`timeout_ms` 非 None 且非正整数 → `ValueError`；judge 侧防御：恶意帧非法值 → 回退默认。

### D6: 迟到响应按 id 丢弃

`resolve_response(id)`：in-flight 命中 → 移除并转发；未命中（含已超时、未知）→ 丢弃 + 限频 warn 日志。超时与响应到达的竞态由主循环每轮先 `expire_now` 再处理新 chunk 的顺序消解。

## Risks / Trade-offs

- [排队时间计入超时（D1）] → Evaluator 多线程并发时，排在长任务后的调用可能"无辜超时" → 语义明确记录在案（等待总时间），evaluator 可将 `CallTimeout` 记为失败用例；出题人可调大调用级超时或减少并发。
- [Python 函数无法中断] → 超时后 host 仍执行完该函数，期间后续调用排队 → 迟到结果丢弃（D6），host 存活语义不变。
- [行为变化：调用级超时首次真正生效] → 此前死循环靠总超时兜底的题目，可能提前按调用超时失败 → 题目级默认值保留 + 文档同步（web-editor.md），出题人可调优。
- [cap_reg 映射生命周期] → 单次评测内有效，容器销毁即消失 → 天然正确，无需清理。
- [capability handler 死循环仍无解] → 本次仅覆盖 capability 超时（注册默认值），handler 死循环由超时错误帧保护调用方（solution），评测可继续；handler 侧死循环本身仍受 Evaluator 总超时兜底。

## Migration Plan

1. 按 tasks.md 顺序实施：tracker 模块 → SDK 扩展 → dual 主循环接入 → E2E → 文档。
2. 协议向后兼容：旧 SDK 不发 `timeout_ms`、不注册 cap_reg → judge 回退默认；无需数据迁移、无 DB schema 变更。
3. 回滚策略：judge 侧改动集中在 dual 模块（tracker 可整体移除）；SDK 签名向后兼容（新增可选参数）。任一环节回退均不破坏旧题目。
4. 部署顺序：先发 noj-judge（tracker + 主循环），再发 SDK 镜像（evaluator-python / solution-python 重建），noj-core 无行为变更（仅注释）。

## Open Questions

- 无。设计已由 brainstorming 流程确认（计时起点、范围、capability 默认值机制、迟到响应丢弃均经用户拍板）。
