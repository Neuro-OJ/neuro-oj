# Agent Note: Gateway 覆盖率门禁复用隔离测试资源

Status: implemented

## Problem

Gateway 的 `test:coverage` 直接执行 `deno test`，绕过正式测试启动器。CI 只提供
`TEST_PG_ADMIN_URL` 与 `TEST_REDIS_URL`，没有注入由集成测试要求的
`NOJ_GATEWAY_TEST_DATABASE_URL`、`NOJ_GATEWAY_TEST_REDIS_URL` 和 namespace，导致
12 个真实 PostgreSQL/Redis 用例在覆盖率 job 中因缺少资源而失败，覆盖率报告也没有数据。

## Decision

让 `test:coverage` 通过 `scripts/test-launcher.ts --coverage=coverage` 运行。启动器
继续为本次 run 创建唯一 PostgreSQL 数据库和 Redis namespace，并在 finally 中清理；
coverage 模式不加 `--no-check`，因此覆盖率门禁仍会检查测试文件类型。普通测试模式保持原有
快速启动行为。启动器只透传受控的 `--coverage` 参数，不开放测试路径、权限或并发绕过。

## Alternatives considered

- 在 CI workflow 中手工拼接 Gateway 专属环境变量：放弃，因为会复制资源创建/清理逻辑，且容易
  与本地验收产生不同证据。
- 让集成测试在缺少资源时 ignored：放弃，因为会把环境缺口伪装成绿色覆盖率。
- 覆盖率继续使用 `--no-check`：放弃，因为 coverage job 应同时暴露测试文件的类型回归。

## Consequences

- CI 与本地 coverage 现在使用同一套隔离资源合同，真实集成用例不再因环境变量缺失而失败。
- coverage 结果包含启动器代码本身，当前本地隔离 PG/Redis 证据为 184 passed / 0 failed /
  1 ignored，All files 86.1% lines、85.7% branches、84.9% functions。
- coverage 任务会创建临时数据库和 Redis namespace，必须依赖显式的测试资源入口；不会读取开发
  `.env`、默认 `DATABASE_URL` 或执行共享 Redis 的 FLUSHDB。
