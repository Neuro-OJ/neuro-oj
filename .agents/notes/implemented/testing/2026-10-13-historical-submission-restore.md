# Agent Note: 旧 Schema 普通提交恢复验证

Status: implemented

## Problem

原始备份没有普通提交，已有恢复结果无法证明升级保留普通提交与评测尝试。

## Decision

在独立恢复库的旧 Schema 中加入明确标记的普通提交及正式尝试，再执行经用户
批准的开发数据清理、标准迁移至 0136 和公开执行归属回填。保持提交时版本未知，
核对原 ID、代码、受理时间、成绩、输出和详情，再通过本人历史服务读取摘要。

## Alternatives considered

- 在新 Schema 写入历史夹具：无法验证真实升级路径。
- 将新增记录描述为原库学生数据：不符合备份事实，明确区分合成验证夹具。

## Consequences

迁移、两次幂等回填及本人历史读取通过；原开发库未被修改。详细依据见
[恢复记录](../../../../dev-docs/reviews/2026-10-13-historical-submission-restore.md)。
该结果不代替执行归属收缩或整套服务恢复验收。
