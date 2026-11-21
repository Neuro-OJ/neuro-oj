# NOJ 工程规范

面向 NOJ 开发者的工程文档。根 `AGENTS.md` 的「规则 + 链接」指向这里的详细文档。
新增文档后**必须在下面补一行**，否则没人能找到它。

## 开发与测试

- [开发指南](development.md)
- [测试体系](testing.md)
- [测试覆盖率报告](test-coverage.md)
- [测试性能基线（suite=core）](test-performance-baseline.md)
- [Core 测试性能实测（本地，2026-11-03）](test-performance-local.md)
- [静默跳过测试清单](test-silent-skips.md)（生成物，基线在 `test-silent-skips.baseline.json`）

## 架构与边界

- [系统架构评审（2026-09-01）](architecture-review-2026-09-01.md)
- [系统架构评审（2026-09-12）](architecture-review-2026-09-12.md)
- [架构整治 P0 基线（2026-10-20）](architecture-baseline-2026-10-20.md)
- [架构整治 P8：协调发布、旧路退役与隔离恢复演练](architecture-remediation-p8.md)
- [noj-core 域边界与所有权（含多副本约束）](domain-boundaries.md)
- [事件域分离](event-domains.md)
- [工作空间授权矩阵与关键数据约束](workspace-authorization-matrix.md)
- [配置分层](config-layering.md)

## 安全与防御

- [防御模式](defensive-patterns.md)
- [上传上限契约（代理 ⇄ 应用）](upload-limits.md)
- [写接口限流矩阵](write-rate-limit-matrix.md)
- [网关出站 DNS 校验与连接绑定（R1）](gateway-dns-binding.md)
- [可重放审计日志](audit-log.md)

## 可观测性

- [日志视觉契约](log-conventions.md)
- [指标目录](metric-catalog.md)

## 评测与 WASM

- [Judge 资源池调度协议](judge-resource-pools.md)
- [WASM 资源池并发离线对照（2026-10-07）](judge-resource-pools-benchmark.md)
- [WASM IO 分类分析工具](wasm-io-analysis.md)
- [WASM IO 插桩本地验证报告（2026-10-06）](wasm-io-analysis-report-2026-10-06.md)
- [NOJ WASM v3 参考毫秒](wasm-reference-v3.md)

## 题务与领域

- [题目版本管理手册](problem-version-management-handbook.md)

## 社区与搜索

- [社区搜索索引验证（Issue #453）](community-search-index.md)

## 归档

- [历史手工 SQL 归档](archives/legacy-sql/README.md)

## 生成物与时效约定

- SSE 事件目录、API 路由目录**不提交**，按需生成：
  `deno run -A scripts/gen-event-catalog.ts` / `deno run -A scripts/gen-route-catalog.ts`。
- 评审/审计类文档是**时点快照**，不回溯修改；被代码推翻时在文首加「修订指针」
  （示例见 `architecture-review-2026-09-01.md`）。
- 计数类陈述（表数量、文件行数、跳过数）不写死在文档里，改由门禁的基线文件承载：
  `test-silent-skips.baseline.json`（静默跳过）、`scripts/check-file-size.ts`（巨型文件）、
  `scripts/check-write-rate-limits.ts`（限流覆盖）。
