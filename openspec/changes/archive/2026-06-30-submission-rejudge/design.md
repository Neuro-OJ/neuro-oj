## Context

当前系统已具备完整的提交生命周期：`pending -> judging -> finished/error`。管理后台（`/admin/submissions`）提供查看和删除操作，但缺少重测能力。当题目评测脚本或测试用例更新后，管理员无法重新评测已有提交。

约束条件：
- 提交状态机严格限制转换路径（`VALID_TRANSITIONS`），finished/error 为终态，无法直接回到 judging
- 评测结果与提交 1:1 关联（`evaluation_results.submission_id` UNIQUE），UPSERT 语义（`ON CONFLICT DO NOTHING`）
- MQ 队列使用 LPUSH/BRPOP，支持多 judge 实例水平扩展

## Goals / Non-Goals

**Goals:**
- 管理员可对任意状态的提交发起重测
- 重测使用题目最新配置（Docker 镜像、评测命令、支持包）
- 新评测结果覆盖旧结果（提交 ID 不变）
- 二次确认弹窗防止误操作

**Non-Goals:**
- 不保留历史评测结果（旧结果被清除，不追溯历史）
- 不修改评测队列优先级（FIFO 队尾排队）
- 不提供按筛选条件批量重测（仅支持按题目全部重测）

## Decisions

### 1. 提交 ID 不变，原地覆盖

**选择**：重测不创建新提交记录，直接重置现有 `submissions` 状态并删除旧 `evaluation_results`。

**替代方案**：创建全新提交（新 ID）。

**理由**：重测的本质是"用同样的代码重新评测"，创建新记录会污染提交历史，且不直观。保留原 ID 则用户可见同一提交的历史状态变化。

### 2. 事务保护数据库状态重置

**选择**：在 `db.transaction` 中原子执行 DELETE + UPDATE：
```
DELETE FROM evaluation_results WHERE submission_id = ?
UPDATE submissions SET status='pending', judge_started_at=NULL, judge_finished_at=NULL
```

**替代方案**：分步执行，不包装事务。

**理由**：防止 DELETE 成功但 UPDATE 失败导致的数据不一致。事务保证两者要么全成功要么全回滚。

### 3. 分离"重置"与"状态推进"

**选择**：事务内直接重置为 `pending`（绕过状态机校验），事务外用 `updateSubmissionStatus(id, "judging")` 推进状态（走标准校验路径）。

**理由**：
- 事务内绕过状态机：当前状态可能是 `finished`/`error`（终态），`VALID_TRANSITIONS` 不允许它们直接回到 `judging`
- 事务外用标准路径：`pending -> judging` 是合法转换，复用现有 `updateSubmissionStatus` 自动设置 `judge_started_at`

### 4. 重新读取支持包

**选择**：每次重测重新从磁盘读取支持包 zip 并 Base64 编码。

**替代方案**：缓存或用旧数据的 Base64。

**理由**：重测的主要动机就是使用更新后的评测配置（含支持包内的评测脚本和测试用例），重新读取确保使用最新版本。

### 5. 批量重测——先校验再执行

**选择**：`POST /api/v1/admin/problems/:id/rejudge` 先检查该题是否存在 `pending`/`judging` 状态的提交。若有，拒绝本次操作并返回错误信息（含数量）。

**理由**：
- `pending`/`judging` 意味着有提交正在评测流程中，强行重置会导致竞态
- 返回错误让管理员知晓存在活跃提交，自行决定等待还是排查——避免静默吞掉问题
- 无 `include_all` 逃生口：感知到问题比强行执行更重要

### 6. 批量重测——单事务 + 逐条入队

**选择**：在一个 DB 事务中重置所有待重测提交，然后逐个构造 JudgeTask 推送到 MQ。

**理由**：
- 事务保证原子性：要么全部重置，要么一个都不重置
- 逐条入队而非批量 MQ：每条提交的代码内容不同，无法合并为一条消息
- 某条入队失败不影响其他提交（记录错误日志，继续处理剩余的）

### 7. 前端确认弹窗（批量）

**选择**：单条重测和批量重测均使用 `useDialog`（SweetAlert2）二次确认。批量弹窗文案提示将影响该题所有提交，包含范围说明。

**理由**：批量操作影响范围大，确认弹窗防止误触。单条重测虽然影响小，但操作也不可逆（结果被覆盖），统一走确认流程让交互保持一致。

## Risks / Trade-offs

- **并发风险**：若旧评测结果在重置后延迟到达，`ON CONFLICT DO NOTHING` 使其被忽略。新结果到达后正常写入。→ 已缓解
- **断言风险**：重测后的评测可能因问题更新而失败（如缺少依赖），导致提交从 `finished` 变为 `error`。→ 可接受——这正是重测的目的（发现因题变更导致的问题）
- **无审计日志**：未记录重测操作审计。→ 延后做（P1 审计功能独立实现）
- **批量重测耗时**：N 条提交需要 N 次 `pushJudgeTask` + N 次 `updateSubmissionStatus`，循环顺序执行。→ 当前量级可接受（练习平台初始化数据量有限）；若未来需要优化可改用 `Promise.all` 并发入队
