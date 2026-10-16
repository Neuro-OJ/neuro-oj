# Agent Note: 管理员可配置私有 LLM 题

Status: implemented

## Problem

LLM 题只允许 P 型，而 P
型强制公开，导致赛前保密题无法同时使用平台模型与私有可见性。

## Decision

允许管理员为 U 型题配置 LLM，保持 U
型默认私有。统一在导入、CRUD、草稿保存及发布路径校验 `admin:full_access`，非
HTTP 路径查询真实权限或使用受信 root 身份。题包解析器只负责结构校验， CLI 与
core 同步；模型别名、联网、平台预算和比赛访问控制保持现有规则。

## Alternatives considered

使用 P
型并依赖赛期隐藏无法保证赛后私有；放开普通用户配置会扩大平台模型费用边界。 修改
P 型公开约束涉及数据库迁移及题库语义，超出本次修复范围。

## Consequences

无需数据库迁移或 Judge 协议升级。普通角色即使已有 Evaluator 联网权限，也不能配置
U 型 LLM， 并且不能发布管理员为其 U 型题添加的 LLM
草稿。私有题面和评测包继续使用原有访问控制。
