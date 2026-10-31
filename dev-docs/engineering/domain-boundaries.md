# noj-core 模块边界与所有权

> 本文档说明 noj-core 当前模块化边界；机器可读的所有权与测试映射以
> [`module-boundaries.json`](./module-boundaries.json) 为准。业务模块通过窄合同和
> application 组合协作，运行时与 HTTP 层不得反向依赖业务实现。

## P3 目标模块结构诊断

P3 的目标分区、遗留域归属、表所有权以及正式测试/CI 映射统一记录在
[`module-boundaries.json`](./module-boundaries.json)。脚本
[`scripts/check-module-boundaries.ts`](../../scripts/check-module-boundaries.ts) 读取这份
元数据并扫描 `noj-core/src/**/*.ts` 以及被源码导入的 JSON 资产的真实文件图。它不把目录改名当成迁移完成，
也不把门面或类型签名当成运行时隔离：

- 解析使用仓库已锁定的 TypeScript Compiler API `npm:typescript@5.9.2`，而不是手写
  lexer。`import type`、`export type` 和只含 `type` 的具名导入只进入类型图；混合
  具名导入、`export *` 以及字面量 `import("...")` 进入运行时图。模板表达式中的
  dynamic import 会被 AST 遍历发现，变量路径则直接报告为无法解析；字符串、注释和
  正则字面量不会产生依赖边。
- Tarjan SCC 只在运行时边上计算。类型图另行统计，因此把副作用藏到名为
  `types.ts` 的文件仍会被运行时图捕获。
- 模块迁移完成后使用 `--strict`；该命令已经接入仓库门禁，不能用目录改名或
  兼容门面掩盖运行时依赖环。
- `facade-export-star`、HTTP 导入 system actor factory、runtime 反向导入业务模块、
  业务模块反向依赖 read-models 都是结构规则。跨模块导入另一个模块的
  `services/routes/workers/consumers` 目录只作为写侵入的语法诊断；它不能证明某个
  函数的实际读写语义，语义级写调用仍需随应用用例迁移和行为测试确认。

当前结构门禁同时检查运行时/类型依赖图、未解析动态导入、模块门面、表所有权与
目标根目录；故意破坏用例由 `scripts/check-module-boundaries_test.ts` 提供，并列入
`scripts/gate-list.ts` 的门禁自测集合。生产依赖图必须保持 runtime/type SCC 为 0。

## 共享层 `src/shared/`

共享层只放“真正跨模块复用且无业务归属”的基础设施，**不得反向依赖
`src/modules/**`**。

| 子目录                  | 职责                                           |
| ----------------------- | ---------------------------------------------- |
| `shared/base/`          | 错误体系、日志、常量、日期、SQL 行工具         |
| `shared/config/`        | 系统设置注册表、生产配置校验                   |
| `shared/db/`            | 数据库连接、迁移、Drizzle schema               |
| `shared/http/`          | 请求体解析、分页、文件流、Hono Env 类型        |
| `shared/mq/`            | Redis 连接管理、通用消费者基类                 |
| `shared/sse/`           | 事件总线、SSE 流、订阅/重放辅助                |
| `shared/rate-limit/`    | 通用限流原语（依赖系统设置的限流在 system 域） |
| `shared/security/`      | CIDR、公共 ID、图片校验                        |
| `shared/observability/` | 低层 kernel：指标注册表、写侧契约、日志上下文  |

> 注：request-context、健康路由和平台观测实现位于
> `src/modules/platform/observability/`；shared 只保留无业务归属的观测契约和写入
> kernel。

## 模块目录

| 模块          | 目录（当前）                  | 主要职责                                                                 |
| ------------- | ----------------------------- | ------------------------------------------------------------------------ |
| access        | `src/modules/access/`          | 身份、认证、RBAC、工作空间成员/邀请、授权和资源政策                       |
| problems      | `src/modules/problems/`        | 题目、标签、题目包、支持包、题单与题面版本                               |
| evaluations   | `src/modules/evaluations/`     | 提交、评测结果、评测队列、重测、自测与有效成绩                           |
| contests      | `src/modules/contests/`        | 竞赛、参赛者、题目关联、澄清与竞赛读模型                                 |
| education     | `src/modules/education/`       | 班级、作业、教学授权、学情、反馈、求助和补题                             |
| communication | `src/modules/communication/`  | 社区、私信、内容审核与通知                                               |
| assets        | `src/modules/assets/`          | 对象存储、容量预约、存储对象生命周期                                     |
| platform      | `src/modules/platform/`        | 系统设置、审计、法律文档、Gateway 平台能力与观测/健康/SLO                 |
| read-models   | `src/modules/read-models/`     | 搜索、统计、排行榜、Dashboard 等只读投影                                 |
| application   | `src/modules/application/`      | 跨模块事务编排、后台任务 handler 与系统组合入口                           |
| http          | `src/modules/http/`             | HTTP 路由、middleware 与 admin 聚合装配                                  |
| runtime       | `src/modules/runtime/`          | 持久后台任务、生命周期、系统 actor 与运行时合同                          |

## 表所有权

| 表                                                                                                                                                                                                                                                                                                                            | 域                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `users`、`oauth_accounts`、`roles`、`permissions`、`user_roles`、`password_reset_tokens`、`tfa_recovery_codes`、`user_bans`                                                                                                                                                                                                   | identity                                               |
| `problems`、`tags`、`problem_tags`、`trainings`、`training_problems`                                                                                                                                                                                                                                                          | catalog                                                |
| `objective_questions`、`objective_submissions`                                                                                                                                                                                                                                                                                | objective                                              |
| `submissions`、`evaluation_results`、`self_tests`、`sse_events`                                                                                                                                                                                                                                                               | submission                                             |
| `contests`、`contest_problems`、`contest_participants`、`contest_clarifications`                                                                                                                                                                                                                                              | contest                                                |
| `community_boards`、`community_board_role_grants`、`community_posts`、`community_comments`、`community_post_likes`、`community_comment_likes`、`community_bookmarks`、`community_follows`、`community_activity_events`、`community_reports`、`community_moderation_actions`、`community_sanctions`、`community_notifications` | community                                              |
| `conversations`、`messages`、`conversation_reads`、`message_deletions`                                                                                                                                                                                                                                                        | messaging                                              |
| `system_settings`、`announcements`、`audit_logs`、`ip_bans`、`judge_images`                                                                                                                                                                                                                                                   | system                                                 |
| `llm_providers`、`llm_usage`、`llm_quotas`                                                                                                                                                                                                                                                                                    | noj-llm-gateway（同库 public schema，core 不直接读写） |

> 注：`check_ins` 由 identity 域拥有（用户签到）；`sse_events` 由 submission
> 域拥有（评测/状态事件），未来若作为通用 outbox 再调整为 shared。

## 模块规则

1. 模块的表写入必须落在 `module-boundaries.json` 声明的 owner 内；跨模块写入只能
   通过明确的 `contracts/` 或 application 事务合同完成。
2. `src/shared/` 只依赖 shared 与无业务归属的基础设施，不得反向依赖模块实现。
3. `runtime` 不得反向导入业务模块；业务 handler 由 application 注入。
4. `read-models` 只提供查询/投影能力，不成为业务写入链的隐式依赖。
5. `http` 负责路由装配，跨模块业务事务由 `application` 组合，不在路由中拼接深层
   service 实现。
6. 模块内 tests 可构造跨模块集成场景，但生产代码必须通过严格边界检查；当前门禁为
   `deno run -A scripts/check-module-boundaries.ts --strict`，负例见
   `scripts/check-module-boundaries_test.ts`。

## 多副本约束（2026-09-12 架构评审 §2.6）

**当前部署为单副本**（`docker-compose.prod.yml` 未声明 `deploy.replicas`）。
业务事实、额度、限流及要求跨副本一致的状态使用
Redis/DB。只读、可容忍短暂不一致的
公开站点元信息与展示类系统配置，可以使用有界且带 TTL
的进程内缓存；新增缓存须在下表登记
TTL、数据来源及多副本后果。其余进程内可变状态须显式标注“单副本专用”。
认证、授权、封禁与评测正确性不能依赖此类展示缓存。

BFF 公开站点元信息沿用 Redis 的 30 秒 TTL 缓存，不使用分布式填充锁。
并发未命中可各自匿名回源，不因等待其他请求而返回
504；读取失败绕过缓存，写入失败仍返回已加载结果。
此处没有新增进程内缓存，也不改变 Core 系统配置的重新加载失效机制。

| 位置                                                  | 状态                                    | 多副本后果                              | 现状                                                             |
| ----------------------------------------------------- | --------------------------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| `modules/platform/system/services/system-settings.ts` | 配置缓存 `Map`                          | A 副本改设置，B 副本读到旧值            | **已修**：变更广播 `noj:events:settings`，各副本重新加载（见下） |
| `modules/read-models/queries/services/stats-cache.ts`  | 站点统计计数器                          | `/stats` 随负载均衡抖动                 | 单副本专用（未修）                                               |
| `modules/evaluations/mq/sweeper.ts`                   | `_firstSeen`/`_lastRequeue`             | 重复重投判定失准，可能双份投递          | 单副本专用（重投本身 at-least-once 幂等）                        |
| `modules/access/identity/.../banCache.ts`             | 封禁缓存（60s TTL）                     | 封禁生效延迟不一致（最长 60s）          | 单副本专用（TTL 兜底）                                           |
| `modules/platform/system/middleware/rate-limit.ts`    | 限流计数                                | 阈值被放大 N 倍                         | 单副本专用（文件内已注明）                                       |
| `modules/read-models/queries/services/rankings.ts`    | 物化视图刷新节流                        | 各副本各刷一次                          | 单副本专用                                                       |
| `modules/problems/services/problems/problems-stats.ts` | 题目统计缓存 `statsCache`（5 分钟 TTL） | 各副本各自缓存，最多 5 分钟内读到旧统计 | 单副本专用（TTL 兜底）                                           |
| `shared/runtime/`、`shared/mq/base-consumer.ts` | 受管任务句柄、关闭标记及可注销的停止等待者 | 只能停止本进程的任务；多副本必须逐个排空 | 单副本专用的生命周期装配；业务进度仍在 DB/Redis |
| 教学、存储核对、审计、提交 worker 与 SSE 保留任务的 `start*` | 周期任务单例句柄，停止后等待在途轮次完成再释放 | 单例只阻止同进程重复启动；多副本依靠既有 DB 租约和业务幂等 | 单副本专用的启动/关闭控制，不承载业务事实 |
| `shared/sse/sse-stream.ts` | 应用实例拥有的 SSE 连接注册表 | 每个副本关闭自己的流，客户端重连后重新授权 | 单副本专用的连接生命周期；Core 装配显式注入 scope |

**跨副本失效的正确做法（务必注意）**：`getSetting()` 在缓存未命中时**不回查
DB**， 而是走 env → default
兜底链。因此失效必须是**重新加载**（`refreshSettingsCache()`， 先读 DB
再原子替换缓存），**不能只 `cache.delete()`** —— 只删缓存会让副本读到默认值
而非真实新值。回归用例：
`modules/platform/tests/services/system-settings-invalidation.test.ts`。

新增设置项/新配置读取方无需额外适配：只要走
`getSetting()`，就会自动获得该失效通道。
