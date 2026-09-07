# Agent Note: 社区搜索 trigram 索引

Status: implemented

## Problem

社区搜索的标题和正文使用 `ILIKE '%keyword%'`，0039 的全文索引无法覆盖中文子串召回，
且查询在社区帖子增长后会退化为全表扫描。少于三个字符的关键词本身不能生成有效 trigram，
也不应为了性能改变既有搜索语义。

## Decision

- 新增 Drizzle 迁移 0070，安装 `pg_trgm` 并为 `community_posts.title`、`content` 建立 GIN
  trigram 索引。
- 保留 0039 的 FTS 表达式索引及现有 ILIKE/FTS OR 条件，确保英文全文和中文子串结果兼容。
- 2 字符关键词继续允许请求，文档和基准明确其可能采用 Seq Scan；不对所有输入强制索引路径。
- PGlite 测试 DDL 尝试创建扩展/索引但在扩展不可用时跳过，避免用测试运行时能力伪装生产能力。
- 增加中文、英文、中英文混合、短关键词回归测试和 10 万帖子 EXPLAIN/P50/P95 基准入口。

## Alternatives considered

- 改用中文分词全文检索：召回能力更强，但需要词典和额外部署，超出本 Issue 范围。
- 仅删除 0039 FTS 索引：会破坏既有英文全文相关性查询，且不能覆盖所有查询分支。
- 拒绝少于三个字符的关键词：能规避慢查询，但会改变既有 API 语义，故不采用。
- 在 PGlite 中伪造 trigram 索引：PGlite 未打包 `pg_trgm`，伪造会让测试结果失真。

## Consequences

- 生产 PostgreSQL 会为常见三字符以上子串提供可选 Bitmap/Index Scan，标题和正文索引会增加
  写入与存储成本。
- 低选择性、短关键词仍可能 Seq Scan，这是 PostgreSQL 优化器的合理选择。
- 需要在生产部署中确认 `pg_trgm` 扩展可用，并使用基准脚本记录迁移前后 P50/P95 和索引体积。
