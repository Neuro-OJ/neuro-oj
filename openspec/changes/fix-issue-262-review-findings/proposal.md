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
- 不改变 JudgeTask 消息字段，不新增数据库迁移，不引入新的外部服务依赖。
