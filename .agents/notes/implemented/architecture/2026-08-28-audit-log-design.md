# Agent Note: 可重放审计日志设计文档

Status: implemented

## Problem

LLM 网关只记录用量，不保存完整请求/响应；出现问题时无法重建“模型看到了什么、返回了什么”。

## Decision

新增 `docs/engineering/audit-log.md`，定义可重放审计日志的目标结构与规则：

- 记录 `request_id`、`submission_id`、`provider_id`、`model`、请求、响应、时间。
- 敏感字段不落明文。
- 保留策略与 `auditLogs` 对齐（默认 90 天）。

当前阶段先固定设计，实际写入 PostgreSQL 的实现在后续里程碑完成。

## Alternatives considered

- 立即实现完整 transcript 落库：涉及 LLM 网关请求/响应改造，体量大，先以文档锁定契约。
- 不记录：审计和复现能力缺失。

## Consequences

- 后续实现有明确数据契约。
- 为 LLM 回放测试提供长期数据基础。
