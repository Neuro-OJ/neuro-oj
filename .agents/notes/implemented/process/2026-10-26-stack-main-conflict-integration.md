# Agent Note: 分层 PR 同步 main 并消解业务冲突

Status: implemented

## Problem

产品架构分层栈的底层 PR #643 与 main 存在冲突。main 新增的平台错误重试、
私有 LLM 题、模板保护与 Gateway 诊断仍使用升级前的题库与结算合同。

## Decision

在各层追加合并提交，保留原有提交及 PR 依赖。题目权限采用 Domain 合同，
公开竞赛编号在访问检查前解析，重试恢复查询携带使用域。Gateway 保留持久账本、
取消上游请求及配额诊断；无法证明零计费的断连保留预占等待对账。

## Alternatives considered

- 重写既有分层历史：用户要求允许追加修复，无需改写已有提交。
- 整文件采用任一侧：会丢失 Domain 改造或 main 的线上缺陷修复。

## Consequences

各层保持独立 PR 并可按依赖顺序评审。合并后的候选必须重新运行检查，
旧提交的通过记录不能证明新增合并提交已通过。
