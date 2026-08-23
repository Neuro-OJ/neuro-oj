## Context

性能基准使用数据库重置与大规模种子数据，CI 的 PostgreSQL 服务容器可安全清理，但本地开发连接不能被隐式使用。

## Decisions

- 仅在 `NOJ_RUN_PERF=1` 时初始化或重置数据库。
- 外部数据库要求 `NOJ_PERF_ALLOW_EXTERNAL_DB=1` 明确确认；CI 设置该变量。
- 默认结束时重置测试数据库；`NOJ_PERF_KEEP_DATA=1` 跳过清理。
