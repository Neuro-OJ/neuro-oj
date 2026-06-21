## Context

noj-judge 目前仅有 `src/main.rs` 骨架（24 行），连接 Redis 后 PING
退出。noj-core 端 `pushJudgeTask` 能将 JudgeTask LPUSH 到
`noj:judge:queue`，但缺少两样东西：(1) 消费任务的 judge worker，(2)
接收结果的结果消费者。现有架构依赖 Docker 做沙箱、Redis
做消息队列，但核心评测逻辑完全空白。

## Goals / Non-Goals

**Goals:**

- 实现 noj-judge 主循环：BRPOP 拉取任务 → Docker 容器执行 → LPUSH 返回结果
- 实现 noj-core 结果消费者：BRPOP 结果列表 → 更新 submission 状态 → 写入
  evaluation_results
- 构建 `noj-judge-python` Docker 镜像
- 标准化 evaluate.py 输出格式（`---RESULT---` + JSON）和通用 CaseResult 结构
- 安全沙箱：network none、CPU/内存限制、容器超时强制清理

**Non-Goals:**

- 多语言支持（仅 Python 3）
- 多 judge 实例并发（单 worker）
- 精确资源监控（time_ms / memory_kb 后续通过 Docker stats 获取）
- 死信队列 / at-least-once 语义（MVP 用简单 BRPOP）
- Special Judge / 交互式题目

## Decisions

### 1. Docker API: bollard（而非 docker-api）

bollard 是 Rust 生态最活跃的 Docker SDK，Tokio
原生异步，文档完善。`Docker::connect_with_local_defaults()` 通过 Unix socket
连接，零配置。

### 2. 结果投递: LPUSH/BRPOP（而非 PUBLISH）

用户明确选择 LPUSH。PUBLISH 是即发即忘的——core 不在线时结果永久丢失。LPUSH
到列表 `noj:judge:results`，core 用 BRPOP 消费，结果持久化在 Redis 中，core
重启后可继续消费。代价：需要额外连接（BRPOP 是阻塞的）。

### 3. 并发模型: Semaphore + tokio::spawn

主循环单线程 BRPOP 拉取，每个任务 spawn 独立 tokio task
处理，tokio::sync::Semaphore 限制并发数（默认 2）。比线程池更轻量，比无限制
spawn 更可控。

### 4. 沙箱: 一次性容器（而非预创建/复用）

每个评测创建新容器，`AutoRemove=true`
执行完自动清理。比容器池简单，比复用容器安全（无状态残留）。性能开销可接受（Docker
容器创建通常在 200-500ms）。

### 5. 评测策略: evaluate.py 自定义（而非 Judge 主导）

Judge 只负责沙箱 + 运行 judge_command + 解析 `---RESULT---` 标记。评分逻辑完全在
evaluate.py 中，每个题目可自定义评分规则。Judge 不假设 evaluate.py 的行为。

### 6. 支持包传递: Base64 编码（而非本地路径/HTTP）

支持包通过 Base64 编码直接嵌入 JudgeTask 消息体。core 在 `createSubmission()`
时读取 zip → Base64 → 塞进 `JudgeTask.support_package_base64`，judge
解码到临时目录。去掉了 `support_package_path` 字段，仅在 Base64 一个通道传递。

优点：零新组件，立即解决分布式部署。缺点：重复传输、Redis
内存占用增加。后续需要迁移到 HTTP 下载时，只需在 JudgeTask 新增 URL
字段，改动极小。

### 7. 错误处理: anyhow + thiserror + tracing

应用层用 anyhow（简单），库类型用 thiserror（精确），tracing
提供结构化日志。容器异常时 Judge 自行构造 status（TimeLimitExceeded /
RuntimeError / SystemError）。

## Risks / Trade-offs

| Risk                                    | Mitigation                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| BRPOP 取出后 judge 崩溃 → 任务丢失      | MVP 接受此风险。后续用 Redis Streams + consumer group 实现 at-least-once      |
| `---RESULT---` JSON 解析失败 → 结果丢失 | Judge 保留完整 stdout，status 设为 `SystemError`，output 中保留原始输出供调试 |
| Docker daemon 不可用                    | Judge 启动时 ping Docker，失败则退出并报错                                    |
| evaluate.py 无限运行                    | 容器超时 = time_limit_ms + 5s 余量，超时后 Docker kill 容器                   |
| 容器内代码有恶意行为                    | `NetworkMode=none`、内存/CPU 限制、无宿主机敏感路径挂载                       |

## Migration Plan

无需迁移——judge worker 和 result consumer 都是新增组件。唯一 BREAKING
变更是结果队列格式（PUBLISH → LPUSH），但由于此前没有消费者，无兼容负担。

部署步骤：

1. 构建 `noj-judge-python` Docker 镜像
2. 启动 noj-core（含新增 result consumer）
3. 启动 noj-judge（cargo run）
4. 基础设施（Redis、PostgreSQL）通过 docker-compose 已就绪
