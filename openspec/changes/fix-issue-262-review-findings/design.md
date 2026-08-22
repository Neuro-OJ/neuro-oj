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

## Risks / Trade-offs

- [风险] Lua/EVAL 未被某些极简 fake Redis 或旧 Redis 代理支持 → 测试 fake 增加 EVAL 实现，并在运行时让 Redis 命令错误按现有队列错误路径返回。
- [风险] 默认并发从无限制变为 2，可能降低高配置机器的吞吐 → 通过 `JUDGE_MAX_CONCURRENT_JUDGES` 显式调高，并在日志中记录生效值。
- [风险] semaphore 闸门与已有 drain 交互不当可能导致关闭等待 → permit 只在成功拉取后交给 task，drain 继续等待同一个 `FuturesUnordered`，不增加额外后台 worker。
- [风险] 开发环境存在非 3000 端口的前端实例 → 可通过生产式 `CORS_ALLOWED_ORIGINS` 配置或后续配置扩展解决；本次先覆盖仓库约定的本地 UI 端口。

## Migration Plan

1. 部署 core 代码后，Redis 7 直接支持所需的 EVAL 脚本，无数据迁移。
2. 部署 judge 代码后默认以并发 2 运行；需要更多吞吐时设置 `JUDGE_MAX_CONCURRENT_JUDGES` 为正整数并重启 worker。
3. 回滚代码即可恢复旧行为；新增环境变量不是必填，旧环境无需修改即可启动。
