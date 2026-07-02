## MODIFIED Requirements

### Requirement: 统一容器池管理

系统 SHALL 使用 PoolManager 对所有评测容器进行统一管理。

#### Scenario: 启动时创建初始池

- **WHEN** noj-judge 启动
- **THEN** 系统对 `POOL_IMAGES` 中每个镜像执行 `docker pull`（失败重试 3 次，间隔 5s）
- **THEN** 每个镜像创建 `POOL_INITIAL_SIZE` 个容器，CMD 设为 `sleep infinity`，使用 `POOL_MEMORY_MB` 和 `POOL_CPU` 作为资源限制
- **THEN** 容器全部就绪后，主循环开始从 MQ 拉取任务

## REMOVED Requirements

### Requirement: 池禁用

**Reason**: Semaphore（legacy）模式已被移除，容器池始终启用。

**Migration**: 移除 `POOL_ENABLED=false` 配置。若需控制并发上限，使用 `POOL_MAX_SIZE` 替代 `MAX_CONCURRENT`。
