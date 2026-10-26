# Agent Note: 教学 outbox 重放验收登记通用任务

Status: implemented

## Problem

P4 已将教学事实的生产消费者切换为 `background_tasks` 的 `education.recompute`
handler；`education_outbox` 只保存业务事实和分页游标。 cross-domain 恢复 E2E
为模拟重复/乱序事件而直接插入裸 `education_outbox` 行，
没有同步登记通用任务，真实 Core 因而不会领取这些重放行，等待交付超时。

## Decision

- 保留测试对 `education_outbox` 的直接插入，因为它需要构造重复、乱序和 Core
  停机期间的持久积压。
- 每个重放行同时插入一个唯一去重键为 `outbox:<id>` 的 `education.recompute`
  pending 任务，payload 只携带生产 handler 所需的 outbox 定位字段。
- 重放仍通过真实 Core 的通用后台任务 worker 完成；测试不直接调用
  `processEducationEvent`，也不修改业务事实或绕过租约/恢复语义。

## Alternatives considered

- 重新启动旧 `startEducationWorker` 让它扫描裸 outbox：放弃，生产已停用旧
  worker， 会把验收带回迁移前合同并掩盖部署缺陷。
- 直接在测试进程调用教育投影函数：放弃，无法证明 Core 重启后的真实消费者和
  background task 租约链路。
- 放宽 30 秒等待或把超时标记 ignored：放弃，会把未交付的持久事件伪装成绿色。

## Consequences

cross-domain 恢复验收现在与生产 P4 任务模型一致：重放行可被真实 Core 领取、
按最新事实重算并持久完成；重复/乱序与停机重启的证据仍保留。新 E2E run 需要
确认两项恢复子步骤在隔离栈中通过。
