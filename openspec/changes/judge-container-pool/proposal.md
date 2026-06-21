## Why

noj-judge 当前每个评测任务都要走完整的 Docker 容器生命周期（create → start → run → remove），其中 Docker API 的容器创建和启动操作带来了 500-1000ms 的固定延迟。在评测吞吐量需求增长的情况下，这部分延迟显著限制了系统性能。Issue #32 要求通过容器池化和自动扩缩容来减少评测延迟、提高吞吐量。

## What Changes

- **统一容器池替代 Semaphore**：引入 PoolManager，统一管理所有评测容器。`POOL_SIZE` 既是最大并发数也是池容量上限，替代现有的 `MAX_CONCURRENT` Semaphore
- **容器预创建**：启动时预先创建一批容器（CMD = `sleep infinity`），任务到达时通过 `docker exec` 直达执行，跳过 create/start 步骤
- **即时创建**：池空但未达上限时，即时创建新容器执行任务（也受 Pool 管理），用完即删
- **排队等待**：已达上限且无空闲容器时，任务排队等待
- **用完即删**：所有容器使用完毕后 `docker rm -f` 删除，不复用
- **自动扩缩容**：PoolManager 根据 QPS、排队时间、容器利用率等指标，自动调整目标池深度（每个 noj-judge 实例独立决策，无中心化依赖）
- **镜像预拉取**：启动时对配置的评测镜像执行 `docker pull`，替换当前按需检查方式
- **文件注入**：通过 tar 打包 + `docker put_archive` 将支持包和用户代码注入容器
- **运行时调整内存限制**：通过 `docker update` 在 exec 前将容器内存限制调整到任务规格，保证 OOM 检测正确
- **环境变量配置**：所有参数通过环境变量控制，与现有风格一致
- **不会修改的现有行为**：`network_mode: none` 安全隔离、`---RESULT---` 标记协议、评测结果数据结构

## Capabilities

### New Capabilities

- `container-pool`: 统一容器池管理——容器生命周期（创建、分配、回收、删除）、自动扩缩容（基于 QPS/排队时间/利用率）、健康检查、优雅关闭

### Modified Capabilities

- `docker-sandbox`: 新增池化执行路径（docker update 调整内存 → docker cp 注入文件 → docker exec 执行）；删除原有 Semaphore/fallback 路径的区分
- `judge-worker`: 评测编排改为统一池模式（acquire → exec → destroy）；移除 `MAX_CONCURRENT` 信号量，由 PoolManager 统一控制并发

## Impact

| 模块 | 影响 |
|------|------|
| noj-judge/src/main.rs | 移除 Semaphore 初始化；改为初始化 PoolManager；主循环精简为 BRPOP → acquire → exec → release |
| noj-judge/src/config.rs | 移除 `MAX_CONCURRENT`；新增池相关环境变量 |
| noj-judge/src/sandbox/container.rs | `run_in_container()` 仅用于即时创建路径；提取公共函数 |
| noj-judge/src/judge/runner.rs | evaluate() 通过 PoolManager acquire/release 执行 |
| noj-judge/src/pool/（新增） | PoolManager 核心模块 + exec + copy + auto-scaler + 熔断/指标，约 1000 行 |
| noj-judge/tests/ | 新增 e2e_container_pool.rs 覆盖池化全流程 + 安全加固 + 熔断 |
| 移除 | `MAX_CONCURRENT` 环境变量、Semaphore 同步原语 |
| 新增环境变量 | `POOL_ENABLED`, `POOL_INITIAL_SIZE`, `POOL_MAX_SIZE`, `POOL_MIN_SIZE`, `POOL_MEMORY_MB`, `POOL_CPU`, `POOL_IMAGES`, `POOL_IDLE_TIMEOUT`, `POOL_SCALE_INTERVAL`, `POOL_MAX_ARCHIVE_MB`, `POOL_KILL_GRACE_SECONDS`, `POOL_LABEL_PREFIX` |
