## Why

Issue #262 发现了几处会在并发注册、评测队列积压或 judge 重启恢复时放大故障的实现缺口。当前改动需要优先保证数据库冲突返回稳定的业务错误、队列容量检查不被并发绕过、浏览器跨域行为符合凭证请求规范，并限制 judge 对 Docker 资源的并发占用。

## What Changes

- 将用户注册时数据库唯一约束冲突统一转换为 409 Conflict。
- 将评测队列容量检查与入队操作合并为 Redis 原子操作，保持队列硬上限。
- 暴露限流、请求追踪相关响应头，便于浏览器客户端读取。
- 修正开发环境 CORS 的凭证请求配置，允许受控的本地开发来源。
- 复用 judge 进程启动时建立的 Docker client，避免每个任务重复建立连接。
- 为 judge 增加可配置的最大评测并发数，避免 backlog 触发无限制的 Docker 容器创建。
- 将提交服务对队列状态的依赖改为静态导入，移除没有必要的运行时模块加载。
- 将生产环境未配置 `LOG_LEVEL` 时的默认日志级别从 `info` 提升为 `warn`，并保留显式配置覆盖能力。
- 抽取邮件 Provider 必填设置的通用检查逻辑，消除 Aliyun/Tencent 配置校验的重复分支。
- 将 judge 容器的固定 1 核 CPU 限制改为 Worker 级 `JUDGE_CPU_LIMIT_MILLICORES` 配置，默认与安全边界保持向后兼容。
- 增强 judge 评测命令分词，支持反斜杠转义的引号与空格，同时保留孤立末尾反斜杠。
- 为共享支持包缓存增加按目录的进程级并发锁，避免多个评测任务依据不同快照交叉淘汰文件。
- 为 Nuxt 认证代理增加登录/改密成功响应的运行时结构校验，缺少有效 user/token 时返回 500 而不写入 Cookie。
- 让 Nuxt session Cookie 的 `is_admin` 只使用核心按 `admin:full_access` 权限计算的字段，不再回退到角色名称判断。
- 将 core 评测结果消费者从单连接串行扩展为有界的多连接消费者池，默认并发 4 并支持通过 `RESULT_CONSUMER_CONCURRENCY` 调整。
- 明确 local 支持包通过 Base64 内联 Redis 的 16 MiB 消息限制；大包和多实例部署继续使用 S3/MinIO presigned URL，暂不在本变更中引入共享卷或新的下载协议。
- 为新增行为补充 core、Redis MQ 和 judge worker 测试，并同步配置/规范文档。

## Capabilities

### New Capabilities

- `cors`: 定义开发与生产环境的 CORS 凭证、来源及可读取响应头行为。

### Modified Capabilities

- `user-auth`: 并发触发用户名或邮箱唯一约束时仍返回 409，而不是 500。
- `redis-message-queue`: 评测任务入队必须以原子方式执行容量检查，不能突破配置的主队列上限。
- `judge-worker`: judge 必须限制同时执行的评测任务数量，并支持通过环境变量配置该上限。
- `sse-endpoints`: 提交状态 SSE 订阅必须把当前请求的 RBAC 上下文传递给提交详情服务。

## Impact

- 影响 `noj-core` 注册服务、Redis producer、Hono 应用 CORS 中间件及相关测试。
- 影响 `noj-judge` 主循环、运行时配置、Docker client 生命周期及配置测试。
- 影响 `noj-core` 提交状态 SSE 路由及其权限回归测试。
- 影响 `noj-core` 提交服务的模块依赖与相关服务测试。
- 影响 `noj-judge` 资源配置、双容器 HostConfig、运维模板与 CPU 单元测试。
- 不改变 JudgeTask 消息字段，不新增数据库迁移，不引入新的外部服务依赖。
