## Context

当前评测有两层超时：evaluator 整体执行限时（`runtime_config.evaluator.time_limit_ms`）与单次用户函数调用超时（`runtime_config.solution.call_timeout_ms`，issue #198 起支持按调用指定）。但超时后的最终状态判定不明确且与目标语义不符：

- `noj-judge/src/dual/mod.rs:421`：evaluator 总超时 → `JudgeResult::timeout()` = `TimeLimitExceeded`（应为 SystemError——评测流程未正常完成，做题人不可通过改代码解决）；
- `noj-judge/src/dual/mod.rs:352`：启动超时（30s 宽松期）同样返回 TLE；
- `noj-judge/src/dual/mod.rs:518`：无 `---RESULT---` 退出统一判 SystemError，不区分是否曾发送过调用超时错误帧（曾发送且 evaluator 未处理时应为 TLE）；
- `noj-judge/src/dual/mod.rs:683`：错误帧 `code: "Timeout"` 与文档错误码表名 `CallTimeout` 不一致。

已批准的详细设计：`docs/superpowers/specs/2026-08-05-timeout-status-mapping-design.md`；实施计划：`docs/superpowers/plans/2026-08-05-timeout-status-mapping.md`。

## Goals / Non-Goals

**Goals:**
- evaluator 总超时（启动超时 + 整体执行超过 `time_limit_ms`）→ Judge Worker 强制终止，最终状态 SystemError
- solution 单次调用超时：judge 注入 `CallTimeout` 错误帧；evaluator 未捕获（无 RESULT 退出）→ TLE；捕获 → 由 evaluator 决定
- 错误帧 code 统一为 `CallTimeout`（judge 发送端 + SDK 匹配端 + 测试断言），不保留旧 code 兼容
- 收尾判定集中为纯函数 `finalize_outcome`，可无 Docker 单测
- 五处文档同步更新

**Non-Goals:**
- 不修改 noj-core / noj-ui（core 仅把 SystemError 映射为 submission status `error`，无状态判定逻辑；UI 按字符串渲染）
- 不新增强制终止逻辑（既有 `DualContainer::destroy` → `remove_container_force` 已保障容器清理）
- 不引入严格归因（"最后一帧"判定）——见 Decisions
- 不改动 capability 反向调用超时的错误帧接收方（写给 solution，不构成 evaluator 归因）

## Decisions

**D1: 收尾判定纯函数 `finalize_outcome`（方案 B：集中收尾判定）**

```rust
enum TimeoutKind { Startup, Total }

fn finalize_outcome(timed_out: Option<TimeoutKind>, sent_call_timeout: bool) -> JudgeStatus
```

规则（顺序即优先级）：`timed_out.is_some()` → SystemError；`sent_call_timeout` → TimeLimitExceeded；否则 SystemError。

- 备选 A（最小内联）：标志 + 分支就地改状态。改动最小但判定逻辑散布主循环，无法单独单测。
- 备选 C（tracker 扩展）：把归因状态放进 `InFlightTracker`。耦合加深，tracker 职责从"超时计时"扩大为"状态归因"。
- 选 B：语义集中、可对照文档、纯函数表驱动单测成本最低。

**D2: TLE 判定判据——宽泛标志（发生过调用超时即归因）**

`sent_call_timeout` 标志在 judge 向 evaluator 写入 `CallTimeout` 错误帧（`WaitingSide::Evaluator` 分支，即 solution 调用超时）时置位。无 RESULT 退出时标志为真 → TLE。

- 备选严格归因（"最后一次写出的帧是 CallTimeout"）：更精确但边界难定义、复杂度不成比例。
- 权衡接受：evaluator 捕获 CallTimeout 后继续评测、最终因自身 bug 崩溃的场景会误判 TLE——但用户代码超时是评测链断裂的根因，且该场景罕见。

**D3: 优先级——总超时优先于 CallTimeout 归因**

阶段 1/2 deadline 一旦触发直接返回 SystemError，不因曾发过 CallTimeout 而改判 TLE。语义：总超时 = 评测流程未完成（环境侧问题），强制终止是最高优先级。

**D4: 错误帧 code 统一为 `CallTimeout`，不保留旧兼容**

`write_timeout_frame` 发送 `code: "CallTimeout"`；SDK `runner.py:319` 匹配同步改。judge 与 SDK 同仓同步发布，E2E 验证新链路；保留旧 code 反而遗留不一致。

**D5: 标志置位范围——仅 `WaitingSide::Evaluator`**

`WaitingSide::Solution`（solution 等 evaluator 的 capability 反向调用超时）的错误帧写给 solution，不构成"evaluator 未处理 CallTimeout"归因，不置位。

**D6: 强制终止复用既有销毁路径**

总超时分支 return 后由 `run_dual_loop` 调用方的 `dual.destroy()`（`remove_container_force`）强制清理两个容器，无新增 kill 逻辑。

## Risks / Trade-offs

- [宽泛归因误判边界] evaluator 捕获 CallTimeout 后因自身 bug 崩溃 → 判 TLE 而非 SystemError → 接受：用户代码超时是根因，场景罕见；严格归因收益不成比例
- [code 改名兼容] 旧 SDK（匹配 `"Timeout"`）与新 judge 不兼容 → judge 与 SDK 同仓同步发布，E2E 覆盖新链路，接受
- [总超时可能掩盖 TLE] evaluator 死循环等待超时调用时总超时先到 → SystemError 而非 TLE → 语义上总超时 = 评测流程未完成，正确
- [E2E 依赖 Docker] 三种超时场景测试需 Docker daemon → 按既有 `#[ignore]` + `NOJ_RUN_E2E=1` 守卫模式，CI 的 judge-sandbox job 覆盖

## Migration Plan

- 无数据迁移；无协议版本字段变更（错误帧 code 是内部协议字符串，judge 与 SDK 同仓发布）
- 部署顺序：judge + SDK 镜像同步构建发布；旧 code `"Timeout"` 帧在升级窗口内不再产生
- 回滚：还原 `dual/mod.rs` / `runner.py` 提交即可，无持久化状态

## Open Questions

- 无（三项关键决策已与用户确认：启动超时归 SystemError、宽泛归因判据、code 统一 CallTimeout）
