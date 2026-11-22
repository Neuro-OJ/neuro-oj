# Agent Note: 公共 E2E 题目辅助放入既有夹具目录

Status: implemented

## Problem

独立加法题辅助最初放在 `e2e/fixtures`，但项目将 `e2e` 一级目录作为业务测试域
登记。该辅助没有独立测试域或 CI job，新目录使 Domain CI 校验失败。

## Decision

将公共题目辅助移至既有 `noj-tests/fixtures`，更新六处导入。沿用现有共享夹具
路径过滤，不为一个辅助函数新增业务域、CI job 或特殊目录豁免。

## Alternatives considered

- 注册新的 fixtures 测试域：目录没有独立业务场景，不采用。
- 放宽 CI 校验或专门跳过新增目录：增加不必要的配置分支，使用现有结构。

## Consequences

实际自测回归在新导入路径下通过；公共题目的导入、发布及评测行为不变。
移动后的路径由现有 E2E 基础设施过滤覆盖，其他提交与队列测试复用同一辅助。
