# 评测任务三级优先级队列设计（2026-09-08）

> 日期：2026-09-08
> 关联 Issue：[#454](https://github.com/Neuro-OJ/neuro-oj/issues/454)（简化实现方案）、[#432](https://github.com/Neuro-OJ/neuro-oj/issues/432)（容量基线，作为后续触发条件）
> 状态：设计经 brainstorming 流程与需求方确认，待评审
> Scope: noj-core / noj-judge / noj-tests

## 1. 背景与目标

当前所有评测任务进入同一个可靠 Redis 队列 `noj:judge:queue`。竞赛洪峰、普通练习和批量重测会互相挤占；简单按 `high → normal` 阻塞消费又会导致普通/批量任务永久饥饿，并增加 processing 恢复复杂度。

本设计是 #454 的简化实现：不引入动态加权/配额调度，而是采用**固定三级优先级 + judge 侧固定比例轮转**，在保证竞赛提交可靠的同时避免低优先级饿死，并尽量少增加系统复杂度。

目标：

1. 竞赛提交（high）在洪峰下优先被消费；
2. 普通交互提交（medium）和批量重测/维护（low）不会永久饥饿；
3. 保持现有可靠队列语义：BRPOPLPUSH 移入 processing、sweeper 超时重投、结果幂等；
4. 客户端无法伪造高优先级；
5. 本次不做按级可观测性/指标（后续集中处理）。

## 2. 范围决策（已确认）

以下决策均经 brainstorming 逐项确认，作为本 spec 的不可变输入：

| 决策点 | 结论 |
| --- | --- |
| 优先级层级 | high / medium / low 三级 |
| 映射 | high=进行中正式比赛提交；medium=普通练习/其他用户交互提交（含自测）；low=管理员批量重测/离线维护 |
| 调度位置 | noj-judge 每个 worker 本地调度，不新增 core 调度器 |
| 防饿死 | 固定比例轮转，默认 high:medium:low = 4:2:1 |
| 容量上限 | 每级独立上限，默认 high 5000 / medium 10000 / low 20000 |
| 兼容/回退 | 不兼容，强制 noj-core 与 noj-judge 同版本升级；回退=整体回滚 |
| 管理员暂停 | 不做 low 暂停开关 |
| 可观测性 | 本次不做按级指标/健康字段，仅保持现有接口可用（聚合） |
| 结果队列 | 保持单队列 `noj:judge:results` 不变 |

## 3. 队列布局与消息协议

### 3.1 Redis Key

```
noj:judge:queue:high      + :processing / :dead
noj:judge:queue:medium    + :processing / :dead
noj:judge:queue:low       + :processing / :dead
noj:judge:results         （不变）
```

每个优先级主队列、processing 队列、dead 队列的可靠语义与现状一致。

### 3.2 JudgeTask 增加 priority 字段

```ts
export type JudgeTaskPriority = "high" | "medium" | "low";

export interface JudgeTask {
  // ...现有字段
  priority: JudgeTaskPriority;
}
```

- 由 noj-core 在入队时写入，服务端强制推导；
- judge 不信任该字段做调度选择（调度只看队列），但 requeue、日志和后续可观测性会用到；
- Rust `JudgeTask` 同步增加 `priority: String` 字段（serde 反序列化）。

## 4. core 侧优先级分配

| 来源 | 优先级 |
| --- | --- |
| 普通提交且归属于**正在进行中**的竞赛（非进行中竞赛提交跟随 medium） | high |
| 普通提交无 `contest_id`、非进行中竞赛提交、自测 | medium |
| artifact 提交不特殊处理，与普通提交共用同一套优先级推导（按来源与竞赛状态） | 按普通提交规则 |
| 管理员重测（单提交/单题/整场）、离线维护任务 | low |
| pending 恢复 | 按原任务来源恢复：进行中竞赛提交→high，普通/自测→medium，重测→low |

客户端请求体不包含优先级字段；core 根据 DB 中的 `contest_id`、竞赛是否进行中以及调用来源（普通提交 vs 重测）推导，杜绝伪造。

## 5. judge 侧本地调度

### 5.1 固定比例轮转

- 每个 judge worker 独立维护本地游标 `cursor`；
- 轮转序列：`[high, high, high, high, medium, medium, low]`（4:2:1）；
- 每次拉任务：
  1. 从 `cursor` 开始按序列尝试；
  2. 对当前队列执行 `BRPOPLPUSH(queue, queue:processing, 短超时)`（默认 100ms）；
  3. 拿到消息则更新游标并返回；
  4. 当前队列为空则继续尝试序列中下一个队列；
  5. 7 个槽位都空则进入下一轮。
- 效果：high 持续有任务时，low 每轮仍至少被尝试一次；low 有任务时会在其槽位立即被取走，不会饿死。
- 多 worker 下为“近似全局 4:2:1”，不追求精确全局配额。

### 5.2 可靠性保持

- 仍使用 `BRPOPLPUSH` 原子地把消息从主队列移入 `:processing`，崩溃后由 core sweeper 超时重投；
- `requeue_task`（同一用户同时最多 1 个评测在跑）回投时按任务携带的 `priority` 回到对应主队列；
- 结果队列和结果推送逻辑不变。

### 5.3 配置

- 轮转比例和短超时先硬编码/环境变量兜底（如 `JUDGE_PRIORITY_RATIO`、`JUDGE_PRIORITY_POLL_TIMEOUT_MS`），不引入管理后台配置。

## 6. core 侧改动

### 6.1 Producer

- `pushJudgeTask(task, priority)` 按优先级选择队列 key；
- 沿用现有 Lua“容量检查 + LPUSH”，每个优先级独立容量；
- `JUDGE_QUEUE` 单常量改为 `JUDGE_QUEUES = { high, medium, low }` 映射；
- 所有入队调用点传入服务端推导的优先级：
  - `submissions-crud.ts`（普通提交/artifact，按“是否属于进行中竞赛”推导）
  - `self-tests.ts`（medium）
  - `submissions-rejudge.ts`（low）
  - `sweeper.ts`（pending 恢复，按原任务来源推导）

### 6.2 Sweeper / 恢复

- `sweepProcessingQueue` 改为遍历三个优先级的 `:processing`，超时后重投到**同优先级**主队列；
- pending 恢复构建 `JudgeTask` 时带上 `priority`，入队走对应队列。

### 6.3 现有队列功能适配（不新增可观测性）

- `GET /api/v1/queue`（用户队列位置）：在三个主队列中查找该 submission，返回跨队列的 `queue_position` / `queue_length`；
- 管理员删除 pending 提交：在三个主队列中查找并移除；
- 管理端队列健康接口（当前实际路径 `/api/v1/admin/submission/queue/health`）和 `/health`：保持现有响应结构，`judge.queue_length` / `processing_length` 改为三级聚合值，避免破坏现有调用方；**不新增**按级字段/指标。

## 7. 测试

### 7.1 noj-core

- 入队按优先级落到正确队列；
- 每级独立容量上限生效；
- 优先级推导：进行中竞赛提交→high、非进行中竞赛/普通/自测→medium、批量重测→low；
- sweeper 超时后重投到同优先级队列；
- 用户队列位置/管理员删除能跨三个队列工作；
- health 聚合值不破坏现有响应。

### 7.2 noj-judge

- 轮转序列按 4:2:1 拉取；
- 某队列为空时能继续尝试下一队列；
- `requeue_task` 回到同优先级队列；
- 现有 BRPOPLPUSH 可靠性/结果重试测试保持通过。

### 7.3 noj-tests

- 补一条“high 洪峰下 low 仍会被消费”的集成场景。

## 8. 部署

- 不兼容、强制同版本：noj-core 与 noj-judge 必须一起升级，回退=整体回滚到上一版本；
- 无数据库迁移：优先级只存在于消息字段和 Redis key，不改表结构。

## 9. 明确不做（本次范围外）

- 按级可观测性/指标（后面集中处理）；
- 管理员暂停/调整 low 队列；
- 动态加权/等待老化调度；
- 兼容旧单队列或自动迁移；
- 容量基线压测（#432）与“启动条件”数据收集。
