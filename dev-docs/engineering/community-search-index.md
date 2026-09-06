# 社区搜索索引验证（Issue #453）

社区搜索继续使用参数化的 `ILIKE '%keyword%'` 子串语义。迁移 `0070_unusual_starfox.sql`
安装 PostgreSQL `pg_trgm` 扩展，并为 `community_posts.title`、`community_posts.content`
创建 GIN trigram 索引；0039 创建的 FTS 表达式索引保留，继续服务英文全文检索与相关性排序。

## 关键词边界

`pg_trgm` 至少需要 3 个字符才能生成有效 trigram。API 仍接受现有的 2 字符关键词，
短关键词和高命中率关键词允许 PostgreSQL 选择 Seq Scan；这只是优化器选择，不改变结果语义，
也不对所有输入强行承诺使用索引。中文按 Unicode 字符计数，中文、英文和中英文混合查询均保留
原有 ILIKE 召回。

## EXPLAIN 与 P50/P95

在隔离的 PostgreSQL 测试库中执行：

```bash
cd noj-core
DATABASE_URL='postgres://...' NOJ_RUN_PERF=1 \
  deno test -A --no-check tests/perf/community_search_bench.test.ts
```

该基准生成约 10 万条社区帖子，输出 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`、P50 与
P95。验证索引命中时，计划中应出现 `Bitmap Index Scan` 或 `Index Scan`，并包含
`idx_community_posts_title_trgm` / `idx_community_posts_content_trgm`；短关键词或高命中
查询出现 `Seq Scan` 属于预期边界。

变更前后对比可在同一个隔离 schema 中先执行：

```sql
DROP INDEX IF EXISTS idx_community_posts_title_trgm;
DROP INDEX IF EXISTS idx_community_posts_content_trgm;
```

运行一次基准记录无索引的 P50/P95 与计划，再重新执行 `0070` 迁移并运行基准记录有索引
的 P50/P95。索引体积可用以下查询记录：

```sql
SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE indexrelname IN (
  'idx_community_posts_title_trgm',
  'idx_community_posts_content_trgm'
);
```

PGlite 测试运行时不包含 `pg_trgm`，测试 DDL 会尽力创建扩展/索引并在不可用时跳过；生产
PostgreSQL 通过迁移严格创建扩展和索引。
