# NOJ 工程规范

面向 NOJ 开发者的工程文档：

- [开发指南](development.md)
- [测试体系](testing.md)
- [WASM IO 分类分析工具](wasm-io-analysis.md)
- [防御模式](defensive-patterns.md)
- [系统架构评审（2026-09-01）](architecture-review-2026-09-01.md)
- [系统架构评审（2026-09-12）](architecture-review-2026-09-12.md)
- [noj-core 域边界与所有权（含多副本约束）](domain-boundaries.md)
- [Capability Seam](capability-seams.md)
- [事件域分离](event-domains.md)
- [SSE 事件目录](event-catalog.md)
- [API 路由目录](route-catalog.md)
- [配置分层](config-layering.md)
- [可重放审计日志](audit-log.md)
- [日志视觉契约](log-conventions.md)
- [指标目录](metric-catalog.md)
- [写接口限流矩阵](write-rate-limit-matrix.md)
- [社区搜索索引验证](community-search-index.md)
- [静默跳过测试清单（生成物）](test-silent-skips.md)

根 `AGENTS.md` 中的“规则 + 链接”指向这里的详细文档。

## 文档时效约定（2026-09-12 起）

- **评审/审计类文档是时点快照**，不回溯修改既有结论。被代码推翻时，在文档顶部加
  「修订指针」指向最新结论（示例见 `architecture-review-2026-09-01.md`）。
- **可机检的目录改为生成产物**：`route-catalog.md`、`event-catalog.md`
  由脚本生成并由 `--check` 门禁校验；`metric-catalog.md` 的指标名集合由
  `scripts/check-metrics.ts` 双向比对（缺登记 / 登记了未注册指标都会失败）。
- **计数类陈述（表数量、文件行数、跳过数）不写死在文档里**，改由门禁的基线文件承载：
  `test-silent-skips.baseline.json`（静默跳过）、`scripts/check-file-size.ts`（巨型文件）、
  `scripts/check-write-rate-limits.ts`（限流覆盖）。

- [NOJ WASM v3 参考毫秒](./wasm-reference-v3.md)
