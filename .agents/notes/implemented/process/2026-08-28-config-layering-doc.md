# Agent Note: 配置分层文档

Status: implemented

## Problem

dev/e2e/prod 配置分散在多个模板文件，缺少统一说明，新环境变量容易漏同步。

## Decision

新增 `docs/engineering/config-layering.md`，明确模板分层、规则与校验命令：

- 开发模板、模块模板、E2E 模板、生产模板、本地覆盖。
- 新环境变量必须同步模板。
- `check-env.ts` 承担占位符与必填校验。

## Alternatives considered

- 引入配置框架（如 dotenv-flow）：增加依赖，当前规模不需要。
- 不写文档：模板同步继续靠经验。

## Consequences

- 配置新增/修改时有明确流程。
- 为后续 profile overlay 改造提供文档基础。
