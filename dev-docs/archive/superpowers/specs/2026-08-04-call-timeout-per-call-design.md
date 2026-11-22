# 调用级超时（call_timeout_ms → RPC / Evaluator SDK 调用参数）设计

> 关联 issue：[#198 将 call_timeout_ms 从固定运行时配置改为 RPC / Evaluator SDK 调用参数](https://github.com/Neuro-OJ/neuro-oj/issues/198)
> 日期：2026-08-04
> 状态：已批准（brainstorming 流程）

## 背景与目标

当前 `call_timeout_ms` 是题目 `runtime_config.solution` 的**固定值**，同一道题的所有 `runner.call()` 共用同一个超时。不同用例耗时差异可能很大（简单用例毫秒级、复杂推理用例数十秒），固定值要么频繁误杀、要么整体放大风险窗口。

**目标**：

1. `runner.call(..., timeout_ms: int | None)`：Evaluator SDK 每次调用可**按调用指定超时**；
2. RPC call 帧增加 `timeout_ms` 字段，未指定时由 Judge Worker 回退到 `runtime_config.solution.call_timeout_ms`（向后兼容，题目级配置保留为**默认值**）；
3. 超时结果语义不变：`CallTimeout`（SDK 侧 `SolutionTimeoutError`）可被 evaluator 记为失败用例继续评测；
4. capability 反向调用（Solution → Evaluator）同样纳入超时，但采用**注册 capability 时配置的默认值**（`register_capability(name, handler, timeout_ms=None)`，经一次性 `cap_reg` 帧上报 Judge）。

## 现状分析（代码位置）

| 位置 | 现状 |
|------|------|
| `noj-core/src/services/problems-types.ts:121` | `runtime_config.solution.call_timeout_ms` 必须为正整数（校验保留） |
| `noj-judge/src/types.rs` | `SolutionRuntime.call_timeout_ms` 反序列化（保留） |
| `noj-judge/src/dual/mod.rs` | **关键：`run_dual_loop` 的 `_call_timeout_ms` 参数带下划线前缀，实际未使用**——调用级超时当前完全未实现，judge 仅双向透明转发帧 |
| `noj-judge/sdk/evaluator/noj_evaluator_sdk/runner.py` | `runner.call(fn, *args)` 无超时参数，SDK 阻塞等响应（注释明确"超时由 judge 端 call_timeout_ms 控制"） |
| `noj-judge/sdk/evaluator/noj_evaluator_sdk/errors.py` | `SolutionTimeoutError` 已存在（错误码 `Timeout`），但 judge 从不生成该错误 |
| `noj-judge/sdk/solution/noj_solution_sdk/host.py` | Solution host 单 worker 顺序执行 call 帧；capability handler 在 reader 线程同步执行 |
| 文档 | `rpc.md` / `evaluator-sdk.md` / `web-editor.md` 已描述 `CallTimeout` 语义，但实现缺失 |

**重要发现**：本次变更实际上会让调用级超时**首次真正生效**。此前用户函数死循环只能靠 evaluator 总超时（`time_limit_ms`）兜底；此后会被调用级超时打断（记为一个失败调用，评测继续）。

## 已确认的设计决策

1. **计时起点**：从 Judge 收到 call 帧的时刻起算（语义 = evaluator 等待本次调用的总时间）。Solution Host 单 worker 顺序执行，并发 call 排队时间计入超时——排队过久触发的超时同样记为 `CallTimeout` 失败用例，不中断整体评测。
2. **capability 超时值来源**：`register_capability` 注册时配置的默认值，经 `cap_reg` 帧一次性上报 Judge；缺省回退题目级 `call_timeout_ms`。Solution 调用侧不指定超时。
3. **协议兼容**：`timeout_ms` 为 call 帧可选字段，旧 SDK 不发送 → Judge 回退题目级默认，天然向后兼容，无需新增协议版本字段。
4. **错误语义沿用**：超时错误帧 `{"type":"error","id":...,"code":"Timeout","message":"..."}` → SDK 抛 `SolutionTimeoutError`（已存在），evaluator 可 try/except 记为失败用例继续评测。
5. **迟到响应丢弃**：已超时的 call_id 标记丢弃，Solution 仍在执行的函数结果不再转发回等待方。

## 协议设计

### call 帧（Evaluator → Judge → Solution）

新增可选字段 `timeout_ms`：

```json
{"type":"call","id":"<uuid>","fn":"solve","args":[1,2],"timeout_ms":5000}
```

- 缺省 / 非正整数 → Judge 回退题目级 `runtime_config.solution.call_timeout_ms`
- Judge 转发给 Solution 的帧**原样透传**（含 timeout_ms；host 只读 `id`/`fn`/`args`，多余字段天然忽略，无需改动 host.py）

### cap_reg 帧（Evaluator → Judge，一次性注册上报，新增）

```json
{"type":"cap_reg","name":"request_llm_completion","timeout_ms":10000}
```

- `register_capability(name, handler, timeout_ms=None)` 时由 SDK 发出
- `timeout_ms=None` → 不注册映射（该 capability 走题目级默认）
- 重复注册同名：最近一次生效（与现有语义一致）
- **cap_reg 帧不转发**给 Solution（Judge 与 Evaluator 的私有协议）

### capability 帧（Solution → Judge → Evaluator）

帧本身不加 `timeout_ms`；Judge 查注册映射计时，缺省回退题目级默认。超时 → Judge 向 Solution 写 `{"type":"error","id":<cap_id>,"code":"Timeout","message":"..."}`。

### Evaluator SDK 签名

```python
def call(self, fn: str, *args: Any, timeout_ms: Optional[int] = None) -> Any
```

- `None` → 帧不带字段；正整数 → 帧带字段；其他（0 / 负数 / 非 int）→ 抛 `ValueError`（SDK 侧校验）

```python
def register_capability(name: str, handler: Callable, timeout_ms: Optional[int] = None) -> None
```

- `timeout_ms` 非 None → 注册映射并发出 `cap_reg` 帧

## Judge Worker 执行层设计

新模块 `noj-judge/src/dual/tracker.rs`（**纯逻辑，零容器依赖**，便于单元测试）：

```rust
struct InFlightTracker {
    inflight: HashMap<String, u64>,          // call_id → 超时 deadline（时刻戳）
    cap_timeouts: HashMap<String, u64>,      // capability name → timeout_ms（cap_reg 上报）
    default_call_timeout_ms: u64,            // 题目级默认
}
```

方法：

| 方法 | 行为 |
|------|------|
| `on_call_frame(frame)` | 解析 `timeout_ms`（字段 → 否则默认；非法 → 回退默认），登记 deadline，返回 `(id, timeout_ms)` |
| `on_cap_reg_frame(frame)` | 更新（timeout_ms 存在）或删除（timeout_ms=None）映射 |
| `on_capability_frame(frame)` | 查映射 → 题目级默认，登记 deadline |
| `resolve_response(id)` | 命中且未超时 → `true`（转发）；未命中 / 已超时 → `false`（丢弃） |
| `expire_now(now)` | 返回已过 deadline 的 id 列表（调用方据此发超时帧并移除） |

### run_dual_loop 改造（dual/mod.rs）

从"双向透明转发"改为"感知帧类型 + in-flight 管理"：

| 收到 | 动作 |
|------|------|
| Evaluator call 帧 | tracker 登记 → 原帧转发 Solution |
| Evaluator cap_reg 帧 | 更新映射（**不转发**） |
| Evaluator capability 帧 | 查映射登记 → 转发 Solution |
| Solution result/error 帧 | `resolve_response(id)` 命中 → 转发 Evaluator；否则丢弃（warn 限频日志） |
| Evaluator result/error 帧 | 同上（capability 响应方向，命中 → 转发 Solution） |

超时检测：主循环 `tokio::select!` 增加 `tokio::time::sleep_until(最早 deadline)` 分支；触发后对每个过期 id 向等待方写 `{"type":"error","id":...,"code":"Timeout","message":"call timeout after N ms"}`，并从 in_flight 移除。无 in-flight 时该分支立即返回不阻塞（保持现有循环语义）。

注意：`classify_line`（protocol.rs）已把任何含 `type` 字段的 JSON 行归为 `Frame`，`cap_reg` 帧无需改动解析层。

## 错误处理与边界

- **超时错误帧**：call 超时 → Evaluator 收 `code="Timeout"` 错误帧 → SDK 抛 `SolutionTimeoutError`；capability 超时 → Solution 收同构错误帧 → solution SDK 抛错（其 pending 尚在，正常分发）。两种都可被调用方捕获记为失败用例。
- **迟到响应丢弃**：已超时 id 的响应不再转发，warn 限频日志（防刷屏）。
- **校验防御**：恶意帧 `timeout_ms` 非法 → 回退题目级默认，不中断评测。
- **总超时关系**：evaluator `time_limit_ms` 仍是外层兜底（评测整体时限），调用级超时是内层；两层都保留。
- **无法中断**：Solution 函数执行无法强杀（Python 线程），超时后 host 存活、后续调用排队——与 issue 声明的"CallTimeout 记为失败用例继续评测"一致。
- **cap_reg 映射生命周期**：单次评测内有效，容器销毁即消失（天然正确，无需显式清理）。

## 测试计划

| 层 | 覆盖 |
|----|------|
| judge 单元测试（tracker.rs） | 帧解析（缺省/指定/非法回退）、cap_reg 注册/覆盖/删除、响应命中/超时后丢弃、expire 触发、并发多 call 各自 deadline |
| Evaluator SDK 单测（tests/test_runner.py） | call 帧含/不含 timeout_ms、非法值抛 ValueError、cap_reg 注册帧发出 |
| judge E2E（e2e_dual_container.rs） | 真实容器：同题两线程并发 call（100ms 超时 + 1s 正常），各自行为正确；缺省回退（不传 timeout_ms → 题目级生效） |
| noj-tests E2E（15_dual_container_judge.ts 或新文件） | 全链路：提交带调用级超时的题目，断言超时用例记为失败、评测继续完成 |

## 文档同步

| 文档 | 变更 |
|------|------|
| `noj-docs/docs/problemsetters/evaluator-sdk.md` | `runner.call(..., timeout_ms=...)` 签名、`register_capability(..., timeout_ms=None)`、SolutionTimeoutError 语义 |
| `noj-docs/docs/problemsetters/rpc.md` | call 帧 timeout_ms 字段、cap_reg 帧、缺省回退规则、错误来源表 |
| `noj-docs/docs/problemsetters/web-editor.md` | `call_timeout_ms` 语义变化（题目级默认值 + 调用级可覆盖） |
| `noj-core/src/types/index.ts` + `problems-types.ts` | 注释同步：语义不变（仍必填正整数），角色变为"默认值" |

## 范围外（明确不做）

- Solution 侧 `call_capability(name, *args, timeout_ms=...)` 调用级指定超时（用户已否决，采用注册时默认值）
- `runner.restart()` 超时（保持现状，透明转发）
- 协议版本字段（可选字段天然兼容，无需版本协商）
- Solution Host 侧超时逻辑（host 无需感知超时；无法中断的 Python 线程由 judge 计时 + 迟到响应丢弃兜底）
