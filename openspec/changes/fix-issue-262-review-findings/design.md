## Context

当前注册服务先做用户名/邮箱预查询，再执行带数据库唯一约束的 INSERT；并发请求可能同时通过预查询，导致其中一个请求收到未处理的 `23505`。评测 producer 当前分两次执行 `LLEN` 与 `LPUSH`，并发请求可能越过队列容量上限。noj-core 的 CORS 同时启用凭证和开发环境通配来源，且未暴露限流响应头。noj-judge 已在启动时建立 Docker client，但每个任务又重新建立 client，主循环也会无上限地 spawn 评测任务。

## Goals / Non-Goals

**Goals:**

- 保持注册重复数据的既有业务语义，覆盖预检查和数据库并发冲突。
- 让评测主队列的容量检查与入队不可分割。
- 让开发环境的 Cookie 跨域请求符合浏览器 CORS 规则，并让客户端读取已有的限流/追踪头。
- 让 judge 的 Docker client 可复用，并把任务拉取与执行并发限制在显式上限内。
- 保持现有 at-least-once、processing、drain 和双容器评测语义不变。

**Non-Goals:**

- 不改变数据库 schema、JudgeTask 字段或队列名称。
- 不恢复已移除的容器池或旧的 `MAX_CONCURRENT`/Semaphore 模式。
- 不新增题目级 CPU 配置，不改变容器固定 1 核的安全限制。
- 不将结果 consumer 改造成并发 worker pool；该项留给后续有指标支持的变更。

## Decisions

### 1. 注册冲突以数据库唯一约束为最终依据

保留现有预查询以便快速返回清晰错误，但在用户 INSERT 处捕获 PostgreSQL/PGlite 的 `23505`。根据唯一约束名称将 `users_username_unique` 映射为“用户名已存在”，将 `users_email_unique` 映射为“邮箱已被注册”；无法识别约束时返回不泄露数据库细节的通用冲突错误。事务不能消除两个事务之间的唯一约束竞态，因此不作为主要修复方案。

### 2. 用 Redis Lua 原子完成容量检查和 LPUSH

producer 使用一个 Redis `EVAL` 脚本：读取主队列长度，若达到上限返回负哨兵值，否则立即执行 `LPUSH` 并返回新长度。这样不会在客户端 `LLEN` 与 `LPUSH` 之间留下竞态窗口，也不会在失败后尝试不可靠的回滚删除。Redis 客户端最小接口和测试 fake Redis 同步增加 `eval` 能力。

容量定义保持为主队列长度；正在 processing 或已启动的任务由 judge 并发上限单独控制，避免把两个不同的资源边界混为一谈。

### 3. CORS 使用受控开发来源与显式响应头

生产环境继续使用 `CORS_ALLOWED_ORIGINS` 白名单。开发环境使用固定本地 UI 来源（localhost 与 127.0.0.1 的 3000 端口），而不是反射任意来源或返回通配符。所有环境的 CORS 配置增加所需的 `exposeHeaders`；这只改变浏览器是否能读取已有响应头，不改变服务端实际返回的限流逻辑。

### 4. judge 复用 Docker client并在拉取前做并发闸门

将启动时通过 ping 验证的 `bollard::Docker` clone 到评测 task，删除 task 内重复的 `connect_with_local_defaults()`。主循环使用 `JUDGE_MAX_CONCURRENT_JUDGES` 对 in-flight task 持有 `OwnedSemaphorePermit`；只有存在可用额度时才允许继续拉取任务，避免先把 backlog 全部移入 processing。默认值取 2，非法或零值回退到 2，既提供有限保护，也允许部署环境显式调高吞吐。

permit 由 task 持有到评测及结果投递完成，因此异常返回、结果 fallback 和 drain 路径都会释放额度。配置实现将 1-1024 视为有效范围，超出范围同样回退默认值。现有 `FuturesUnordered` 继续负责跟踪和排空任务。

### 5. 配置命名避免与已移除的旧模式混淆

新增配置采用 `JUDGE_MAX_CONCURRENT_JUDGES`，不复用历史上已删除的通用 `MAX_CONCURRENT`。配置文档与测试同步更新；不会读取旧变量，也不引入容器池相关配置。

### 6. SSE 路由传递完整的权限上下文

提交状态 SSE 路由使用与提交详情路由相同的 `getSubmission` 参数约定，
同时传递 `userId`、`userRole` 和 Hono `Context`。这样 `getSubmission` 会执行实时
RBAC 的 `submission:read_all` 检查，而不是因缺少 Context 退回到未定义角色的旧分支；
SSE 仍只推送状态变更触发事件，不扩大事件载荷。

### 7. 提交服务静态导入队列状态查询

`submissions-crud.ts` 已经静态依赖 `queue.ts` 的队列快照函数，且 `queue.ts`
不依赖 `submissions-crud.ts`。因此直接静态导入 `getSubmissionQueueStatus` 不会形成
循环依赖，同时能让模块依赖在加载期可见，移除每次查询详情时的动态 import 开销。

### 8. 生产日志默认级别

`LOG_LEVEL` 显式配置继续拥有最高优先级；仅在生产环境未配置或配置非法时使用
`warn`，开发/测试环境仍默认 `debug`。这样不会阻止临时的生产诊断配置，
同时降低正常提交与评测流程的 info 日志量。

### 9. 邮件 Provider 配置校验复用

以 Provider 到必填系统设置键/展示标签的映射作为单一配置源，统一执行“读取设置、
判断空值、收集展示标签”的逻辑；警告消息仍保留当前 provider、缺失项和后台配置提示，
不改变邮件 Provider 的选择或启动失败语义。

### 10. Judge CPU 采用 Worker 级统一配置

本次使用 `JUDGE_CPU_LIMIT_MILLICORES` 作为 Worker 级配置，同时约束 Evaluator 和
Solution 两个容器，保持现有 JudgeTask/runtime_config 协议向后兼容；缺省仍为 1 核，
后续如需按题目或容器角色细分，可在协议变更中新增字段。值在配置解析和 HostConfig
构造两层均进行范围保护，避免 0 转化为 Docker 的无限制语义。

### 11. 命令分词使用显式转义状态

在现有轻量分词器中增加 `escaped` 状态：反斜杠消费并转义下一个字符，覆盖引号、
空格等命令参数中的常见场景；末尾孤立反斜杠原样保留。评测命令来自管理员配置，
因此本次不引入 shell 解释器或额外 crate，也不改变命令白名单校验边界。

### 12. 支持包缓存按目录串行化淘汰

`SupportPackageCache` 实例按评测任务创建，实例级锁不能保护共享目录；使用进程级
`OnceLock` 保存“缓存目录 → Tokio Mutex”的映射，使同一目录下的 get、set、atime 更新
和淘汰共享临界区。写入仍先写唯一临时文件再 rename，锁只解决同一 Worker 进程内的
并发快照问题，不改变跨进程共享目录的部署约束。

### 13. 认证代理先校验再写 Cookie

将登录/改密响应中的 token 与 user 提取为独立运行时校验函数；只有字段类型完整时
才写 HTTP-only token Cookie 与 session Cookie。异常响应只记录固定的无敏感信息日志，
返回 500 并丢弃上游响应，避免非空断言导致运行时异常或把无效数据写入客户端 Cookie。

### 14. 管理员会话标记只信任权限计算结果

核心认证响应中的 `is_admin` 已由 `isUserAdmin()` 按 `admin:full_access` 权限（含角色继承）
实时计算。Nuxt 代理将其作为必需布尔字段写入 session Cookie；`role` 仅作为旧版展示字段
兼容读取，缺失时使用普通/管理员的展示值补齐，但不再参与管理员判定。这样自定义角色拥有
管理员权限时仍能通过前端 admin 守卫，普通角色名称也不会被错误授予管理员状态。

### 15. 结果消费者使用有界连接池

保留单个 `createConsumer` 的 at-least-once 流程和 `processing` 确认语义，启动时按
`RESULT_CONSUMER_CONCURRENCY` 创建多个独立 Redis 消费连接。每个连接仍逐条执行
“BRPOPLPUSH → handleMessage → LREM”，多个连接只并行处理不同消息；同一提交的重复/重测
结果由数据库行锁、唯一结果记录和 `rejudge_seq` 继续保证幂等。默认并发为 4，限制在 1-16，
避免误配置耗尽 Redis 或 PostgreSQL 连接；健康状态按消费者池中是否至少有一个连接活跃汇总。

### 16. 本地支持包内联传输暂不改协议

local Provider 明确用于开发/测试，且当前 Judge 通过独立容器运行，不能直接读取 core
的本地目录；其交付方式是 Base64 内联到 Redis 任务，受 16 MiB 序列化消息上限约束。
生产环境已有 S3/MinIO presigned URL 路径，能避免该瓶颈。共享文件系统或带鉴权的 HTTP
下载会同时涉及容器编排、访问控制、过期和回收策略，本次只补充限制文档并将大包部署引导
到 S3，协议改造留给独立变更。

### 17. 提交入队失败使用持久化恢复而非盲目立即重试

当前 `NOJ-067` sweeper 已覆盖“提交行写入成功、Redis 入队失败或进程崩溃”的窗口：
pending 记录超过 2 分钟后进入恢复扫描，sweeper 每 30 秒运行；可重试错误继续等待后续
扫描，消息大小等永久错误转为 error。暂不在 `createSubmission` 中对未知 Redis 错误立即
重试，因为 LPUSH 已成功但响应丢失时无法判别，立即重试可能产生重复评测；现有结果消费
幂等只保证最终数据正确，不能消除重复运行的资源成本。本次补充正式提交恢复回归测试，
更细粒度的消息去重或 outbox 机制另立变更。

## Risks / Trade-offs

- [风险] Lua/EVAL 未被某些极简 fake Redis 或旧 Redis 代理支持 → 测试 fake 增加 EVAL 实现，并在运行时让 Redis 命令错误按现有队列错误路径返回。
- [风险] 默认并发从无限制变为 2，可能降低高配置机器的吞吐 → 通过 `JUDGE_MAX_CONCURRENT_JUDGES` 显式调高，并在日志中记录生效值。
- [风险] semaphore 闸门与已有 drain 交互不当可能导致关闭等待 → permit 只在成功拉取后交给 task，drain 继续等待同一个 `FuturesUnordered`，不增加额外后台 worker。
- [风险] 开发环境存在非 3000 端口的前端实例 → 可通过生产式 `CORS_ALLOWED_ORIGINS` 配置或后续配置扩展解决；本次先覆盖仓库约定的本地 UI 端口。
- [风险] 结果消费者并发提高数据库与后处理压力 → 默认仅启用 4 个连接并设置 16 的上限，部署方可按数据库连接池容量调低 `RESULT_CONSUMER_CONCURRENCY`。

## Migration Plan

1. 部署 core 代码后，Redis 7 直接支持所需的 EVAL 脚本，无数据迁移。
2. 部署 judge 代码后默认以并发 2 运行；需要更多吞吐时设置 `JUDGE_MAX_CONCURRENT_JUDGES` 为正整数并重启 worker。
3. 回滚代码即可恢复旧行为；新增环境变量不是必填，旧环境无需修改即可启动。
