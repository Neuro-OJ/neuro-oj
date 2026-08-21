## ADDED Requirements

### Requirement: 性能基准数据清理与外部数据库保护

系统 SHALL 在搜索性能基准结束后默认清理其测试数据。使用外部 PostgreSQL 运行性能基准 MUST 显式设置确认变量；设置保留变量时系统 SHALL 跳过清理以支持人工分析。

#### Scenario: 默认清理

- **WHEN** 性能基准成功或失败结束且未设置保留变量
- **THEN** 系统清理性能基准创建的测试数据

#### Scenario: 外部数据库确认

- **WHEN** 性能基准检测到外部 PostgreSQL 连接但未设置确认变量
- **THEN** 系统拒绝运行并提示设置确认变量

#### Scenario: 保留性能数据

- **WHEN** 运行性能基准时设置 `NOJ_PERF_KEEP_DATA=1`
- **THEN** 系统在结束时保留测试数据
