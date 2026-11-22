# evaluator 超时与 solution 超时的行为与状态映射设计

> 关联 issue：[#202 明确 evaluator 超时与 solution 超时的行为与状态映射（含文档更新）](https://github.com/Neuro-OJ/neuro-oj/issues/202)
> 日期：2026-08-05
> 状态：已批准（brainstorming 流程）

## 背景与目标

当前运行时配置有两层超时：evaluator 整体执行限时（`runtime_config.evaluator.time_limit_ms`）与单次用户函数调用超时（`runtime_config.solution.call_timeout_ms`，issue #198 起支持按调用指定）。但**超时后的最终状态判定不明确**：

- 调用超时（`CallTimeout`）由 Judge 注入错误帧，若 evaluator 未处理（evaluate.py 因此崩溃退出），最终落成什么状态？
- evaluator 整体超时后 Judge Worker 如何收尾？
- 文档（`result-status.md` / `rpc.md` / `judge-model.md`）均未明确。

**目标**：

1. evaluator 超时（整体执行超过 `time_limit_ms`）：Judge Worker 强制终止评测，最终状态 **SystemError**（评测环境/流程未正常完成，做题人不可通过改代码解决）；
2. solution 超时（单次调用超过 `call_timeout_ms`）：向 evaluator 返回 `CallTimeout` 调用错误；若 evaluator 未捕获或因此异常退出，最终状态为 **TimeLimitExceeded（TLE）**，而不是 SystemError；
3. `CallTimeout` 被 evaluator 显式处理时，状态由 evaluator 决定（可记为 WrongAnswer 等），语义保持不变；
4. 文档五处同步更新。

## 现状分析（代码位置）

| 位置 | 现状 |
|------|------|
| `noj-judge/src/dual/mod.rs:352` | 阶段 1 启动超时（30s 宽松期）→ `JudgeResult::timeout()` = **TLE**（不符合目标语义） |
| `noj-judge/src/dual/mod.rs:421` | 阶段 2 evaluator 总超时（`time_limit_ms` 到期）→ `JudgeResult::timeout()` = **TLE**（不符合目标语义） |
| `noj-judge/src/dual/mod.rs:518` | 无 `---RESULT---` 退出（evaluator 崩溃/EOF）→ `system_error()`；**不区分是否曾发送 CallTimeout**（issue 要求：曾发送且未处理 → TLE） |
| `noj-judge/src/dual/mod.rs:683` | `write_timeout_frame` 发送 `{"type":"error","code":"Timeout","message":"call timeout"}`——code 与文档错误码表名 `CallTimeout` 不一致 |
| `noj-judge/sdk/evaluator/noj_evaluator_sdk/runner.py:319` | `if code == "Timeout": raise SolutionTimeoutError(...)`——需同步匹配新 code |
| `noj-judge/src/dual/container.rs:72` | `DualContainer::destroy` 用 `remove_container_force` 强制清理容器——总超时后的"强制终止"已有保障，无需新增 |
| `noj-core/src/services/submissions-result.ts:73` | SystemError → submission status `error`，其余 → `finished`；无需变更 |
| 文档 | `result-status.md` TLE/SystemError 定义未区分超时来源；`rpc.md:124` / `evaluator-sdk.md:64` 错误码表已有 `CallTimeout` 名但无未处理时的状态说明；`judge-model.md` / `web-editor.md` / `what-is-noj.md` 无状态映射说明 |

## 已确认的设计决策

1. **启动超时归属 SystemError**：阶段 1（30s 宽松启动期）超时说明评测环境未就绪（容器/镜像/启动失败），做题人无法通过改代码解决，语义与 SystemError 一致；符合 #200「启动开销不计入时限」的精神。
2. **TLE 判定判据（宽泛标志）**：以「本次评测是否向 evaluator 发送过 CallTimeout 错误帧」为判据——只要发生过 solution 调用超时且最终无 RESULT，即归因 TLE（用户代码慢是根因）。不做"最后一帧"严格归因（复杂且边界难定义）。
3. **优先级规则**：总超时（阶段 1/2 deadline）优先于 CallTimeout 归因——一旦超时强制终止，一律 SystemError，不因曾发过 CallTimeout 而改判 TLE。
4. **错误帧 code 统一为 `CallTimeout`**：`write_timeout_frame` 发送 `"code":"CallTimeout"`，SDK `runner.py` 匹配同步更新；**不保留**旧 code `"Timeout"` 的兼容分支（judge 与 SDK 同仓同步发布，E2E 验证新链路；保留反而遗留不一致）。
5. **实现组织：集中收尾判定（方案 B）**：新增纯函数 `finalize_outcome`，三个超时/退出分支统一走它；纯函数可无 Docker 单测，语义集中可对照文档。
6. **强制终止**：总超时分支 return 后由既有 `dual.destroy()` 强制删除两个容器，无需新增 kill 逻辑。

## 状态映射表

| 场景 | 触发点 | 最终状态 | 依据 |
|------|--------|---------|------|
| evaluator 启动超时（30s 宽松期） | 阶段 1 deadline | **SystemError** | 评测环境未就绪，做题人无法解决 |
| evaluator 整体执行超时（> `time_limit_ms`） | 阶段 2 deadline | **SystemError** | 评测流程未正常完成；judge 强制终止 |
| solution 调用超时（> `call_timeout_ms`）且 evaluator 捕获 | evaluator 正常输出 `---RESULT---` | **由 evaluator 决定**（如 WrongAnswer） | 语义保持不变 |
| solution 调用超时且 evaluator 未捕获（崩溃/EOF、无 RESULT） | 无 RESULT 退出 | **TimeLimitExceeded** | 用户代码慢是根因 |
| evaluator 异常退出但从未发生调用超时 | 无 RESULT 退出 | **SystemError** | evaluate.py 自身 bug / 环境问题 |

## 代码改动（noj-judge）

### 收尾判定纯函数 `finalize_outcome`

新增（建议 `dual/mod.rs` 内或独立 `dual/outcome.rs`）：

```rust
/// 评测收尾判定：把「评测如何结束」映射为最终状态。
/// 仅在 evaluator 未正常输出 ---RESULT--- 时调用（有 RESULT 走 build_judge_result）。
enum TimeoutKind { Startup, Total }

fn finalize_outcome(
    timed_out: Option<TimeoutKind>,
    sent_call_timeout: bool,
) -> JudgeStatus
```

规则（顺序即优先级）：

1. `timed_out.is_some()` → `SystemError`（强制终止，优先）；
2. `sent_call_timeout` → `TimeLimitExceeded`（用户代码慢是根因）；
3. 否则 → `SystemError`（evaluator 自身异常）。

### `run_dual_loop` 改动

- 新增局部标志 `sent_call_timeout: bool`；阶段 1 与阶段 2 的 in-flight 到期分支在 `write_timeout_frame` 写帧成功后置位；
- 阶段 1 启动超时分支：`timeout()` → `system_error()`（output 保留 "evaluator startup timeout" 类信息）；
- 阶段 2 总超时分支：`timeout()` → `system_error()`（output 说明评测总超时，供运营排查）；
- 无 RESULT 收尾分支（`result_payload.is_none()`）：改用 `finalize_outcome` 判定——`sent_call_timeout=true` 时返回 `timeout()`（TLE），否则保持 `system_error()`；
- 有 RESULT 分支不变（evaluator 决定状态）。

### 错误帧 code 统一

- `write_timeout_frame`（`dual/mod.rs:683`）：`"code": "Timeout"` → `"code": "CallTimeout"`；
- SDK `runner.py:319`：`if code == "Timeout"` → `if code == "CallTimeout"`；
- E2E 断言同步更新。

### 测试

**单测（无 Docker）**：`finalize_outcome` 全分支表驱动测试（`timed_out ∈ {None, Startup, Total} × sent_call_timeout ∈ {false, true}` 组合）。

**E2E（`e2e_dual_container.rs` 新增 3 个 `#[ignore]` 测试）**：

1. **evaluator 超时 → SystemError**：evaluate.py 打印 ready 后死循环，`time_limit_ms` 设短（如 2s），断言最终状态 SystemError；
2. **solution 超时未处理 → TLE**：evaluate.py 调 `runner.call` 不捕获 `SolutionTimeoutError`（异常冒泡崩溃），`call_timeout_ms` 设短，断言最终状态 TimeLimitExceeded；
3. **solution 超时被捕获 → evaluator 决定**：evaluate.py `try/except` 后返回 WrongAnswer，断言最终状态由 evaluator 决定（现有 `dual_call_timeout_fallback_to_problem_default` 已断言用例级 `SolutionTimeoutError`，新增断言**最终状态**）。

## 文档更新（五处）

| 文档 | 改动 |
|------|------|
| `reference/result-status.md` | `TimeLimitExceeded` 补充超时来源说明：区分「evaluator 整体超时 → SystemError」与「单次调用超时未被 evaluator 处理 → TLE」；`SystemError` 补充「evaluator 整体执行超时、启动超时」两个来源 |
| `problemsetters/rpc.md` | 错误码表 `CallTimeout` 一行补充：「该错误由 Judge Worker 直接注入；若 evaluator 未捕获（evaluate.py 异常退出、无 `---RESULT---`），最终状态为 `TimeLimitExceeded`」 |
| `problemsetters/judge-model.md` | 新增/扩展「超时与状态映射」小节：两层超时（`time_limit_ms` / `call_timeout_ms`）× 三种结局（evaluator 捕获 / 未捕获 / 整体超时）的映射表 |
| `problemsetters/web-editor.md` | 运行时配置说明处补充两层超时语义：`time_limit_ms` 超时 → SystemError（评测流程未完成，做题人不可解决）；`call_timeout_ms` 未处理 → TLE |
| `intro/what-is-noj.md` | 「时空限制」一节（现第 82 行附近）的单次调用超时描述补充状态映射：未捕获 → TLE；evaluator 整体超时 → SystemError |

## 模块影响评估

- **noj-core**：仅把 SystemError 映射为 submission status `error`，无需变更；
- **noj-ui**：状态徽章按字符串渲染，无超时文案；
- **noj-judge**：改动集中在 `dual/mod.rs` + SDK `runner.py` + 测试。

## 验收清单

- [ ] `cargo test`（含 `finalize_outcome` 单测）通过
- [ ] E2E 三种超时场景（`NOJ_RUN_E2E=1`）通过：总超时→SystemError / CallTimeout 未处理→TLE / 捕获→evaluator 决定
- [ ] 文档五处同步更新
- [ ] `cargo fmt` + `cargo clippy` 无警告

## 风险与权衡

- **宽泛归因的误判边界**：evaluator 捕获了 CallTimeout 继续评测、最终因自身 bug 崩溃 → 仍判 TLE。权衡后接受：用户代码超时是评测链断裂的根因，且该场景罕见；严格归因（最后一帧）复杂度收益不成比例。
- **code 改名兼容**：旧 SDK（匹配 `"Timeout"`）与新 judge 不兼容。judge 与 SDK 同仓同步发布，E2E 覆盖新链路，接受。
- **总超时优先 SystemError 可能掩盖 TLE**：evaluator 死循环等待超时调用时，总超时先到 → SystemError 而非 TLE。语义上总超时=评测流程未完成，正确。
