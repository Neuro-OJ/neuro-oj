# Agent Note: P1 安全顺序修复（升级验签、迁移锁、Gateway 就绪探针）

Status: implemented

## Problem

架构评审确认了三处“保护条件 / 校验时机”失效的问题，它们都属于**失败时已经产生不可逆
副作用**的顺序缺陷：

1. **升级先启动、后验签**：`update` 的升级序列是 备份 → `compose pull` →
   `waitForStack`（启动目标镜像）→ `verifyImageSignatures`。验签失败时目标栈已经
   启动，且 `--latest` 的暂存配置可能已被提交。更隐蔽的是**校验对象与启动对象不是同一
   份配置**：pull/up 读暂存 env 文件（目标 `NOJ_VERSION`），验签却读
   `prepareAndCheck` 返回的旧 `.env.prod` 键值。对应实现见
   [lifecycle.ts](../../../../noj-cli/src/prod/lifecycle.ts) 的 `upgradeWith`。
2. **迁移锁降级**：`withMigrationLock` 在锁连接创建失败、等待 advisory lock 超时后
   只记录 error 就继续执行迁移 DDL。保护条件失效后仍执行受保护操作，两个迁移器会竞争
   `__drizzle_migrations` 并重复施加同一条迁移。对应实现见
   [migrate.ts](../../../../noj-core/src/shared/db/migrate.ts)。
3. **就绪探针不覆盖真实依赖**：Gateway `/health/ready` 只 `ping()` Redis，既不检查
   数据库，也不反映记账 worker 是否在跑。数据库故障或结算停摆时仍返回 ready，负载均衡
   会把调用继续送到无法记账的副本。对应实现见
   [app.ts](../../../../noj-llm-gateway/src/app.ts)。

## Decision

三项修复按同一条原则执行：**校验/保护必须在副作用之前完成，失败必须显式终止，排障信息
可诊断但不泄露敏感数据**。

1. **发布配置单一事实源**（noj-cli）：新增
   [target.ts](../../../../noj-cli/src/prod/lifecycle/target.ts) 的
   `ResolvedTargetConfig` / `resolveTargetConfig()`，从生效 env 文件（升级时优先
   暂存文件）一次解析出 `{ envFile, env, version, judge, composeOptions }`。
   `upgradeWith` 的顺序改为：解析目标配置 → 口令 → 备份 → pull → **验签** →
   `waitForStack` → 部署元数据 → 提交暂存配置；备份、pull/up、验签、元数据只消费
   同一个对象。`install` 也改为消费同一对象（install 本无“先启动后验签”缺陷，改动用于
   消除双份解析）。验签放在 pull 之后：inspect/cosign 本可直接查 registry，保留 bash 的
   pull 先行次序可让失败只留下镜像缓存、且无任何容器变更；关键不变量是**任何 `up` 之前
   必须通过验签**，由测试钉住。
2. **迁移拿不到锁即失败**（noj-core）：`withMigrationLock` 在未配置 `DATABASE_URL`、
   锁连接创建失败、`pg_try_advisory_lock` 抛错、等待超时（保留 5 分钟上限 / 2 秒重试）
   时统一抛 `MigrationLockError`，**绝不再调用迁移函数**；错误信息含 schema、等待时长
   与排查建议。连接创建、sleep、时钟、等待/重试间隔做成可注入依赖
   （`MigrationLockDeps`），生产默认实现与常量不变，测试零外部依赖。`finally` 保留
   显式解锁与专用连接关闭（会话级锁随连接释放）。
3. **真实就绪探针 + 记账 worker 状态**（Gateway）：`/health/ready` 并行检查
   数据库（真实 `SELECT 1` 并校验结果）、Redis ping、记账 worker 状态；任一失败返回
   503，`detail` 只含 `database_*` / `redis_*` / `accounting_*` 固定类别代码，
   不回显错误文本。`startAccountingWorker` 改为返回可停止、可查询的
   `AccountingWorkerHandle`（`stop()` / `getStatus()`），记录
   `running / lastSuccessAt / lastError / consecutiveFailures`；判定规则：停止即不健康，
   连续 3 轮失败（约 15 秒）判持续失败，启动后 30 秒内尚无成功轮次视为预热。探针抽为
   `createReadyProbe(deps)` 纯函数，`createApp(config, deps?)` 提供依赖注入 seam
   供测试注入假 db/redis/worker（`startBackgroundWorkers` 默认 true，生产行为不变）。

## Alternatives considered

- **把验签提到 pull 之前**：可以更早失败，但会让“镜像已缓存”这一唯一副作用也消失，且与
  bash/部署运维的既有行为差异更大；保留 “pull → 验签 → up” 已满足安全不变量，失败不会
  启动容器。
- **迁移锁失败时继续但降级为只读/单迁移器模式**：迁移器无法协商谁执行 DDL，“只读降级”
  没有可实现的语义；继续无锁执行正是被审查的问题，因此选择失败并由部署流程重试。
- **就绪探针只查进程内 liveness / 交给外部监控**：/health/ready 的消费者是编排层，必须
  在流量进入前反映真实依赖；外部监控无法阻止单副本继续接流量。
- **引入依赖注入容器统一装配**：三个修复只需要局部注入 seam（CLI 已有 runner/io/fetcher
  注入；core 用可选 overrides；Gateway 用可选 deps），引入容器会扩大改动面，不符合本轮
  “只在外部能力需要替换时引入接口”的规则。
- **把 `startAccountingWorker` 保留返回 `() => void` 另加全局状态**：模块级可变状态
  违反多副本约束，且没有“停止后不可查询”的语义；改为显式句柄更小且可测试。

## Consequences

- 升级失败语义收紧：验签失败 → 不启动目标栈、不写部署元数据、不提交暂存配置
  （`.env.prod` 逐字节不变，暂存文件被清理）；新增 4 个 CLI 测试钉住顺序与失败路径。
- 迁移入口语义收紧：无锁/无 `DATABASE_URL` 时启动失败（`main.ts` 本就是致命步骤），
  不再有静默无锁 DDL；新增 6 个零外部依赖测试覆盖成功/超时/连接失败/查询抛错/清理失败/
  缺配置。
- Gateway 行为变化：`/health/ready` 的 `detail` 从字符串改为固定代码数组并新增
  `checks`；`startAccountingWorker` 返回类型变化（仓内唯一调用方 `app.ts` 已同步）。
  已 grep 全仓确认没有解析旧 `detail` 的消费者；监控脚本只匹配 `"status":"ready"`。
- 验证：noj-cli 全量 771 passed / 0 failed / 4 ignored；noj-core 共享测试 306 passed /
  0 failed / 16 ignored（新增 6 例）；noj-llm-gateway 全量 126 passed / 0 failed /
  13 ignored（新增 11 例）；三模块 fmt/lint/type check 通过；文件规模棘轮（lifecycle.ts
  2097 = 基线）与导出 JSDoc 门禁通过。
- 未完成/后续：本批要求的“升级排空过渡能力”留给下一轮 P1 收尾；Gateway 优雅关闭
  （停止领取结算、等待在途、关闭连接）按方案归 P5；本次无真实 PostgreSQL 5 分钟锁超时
  演练、无真实 docker/cosign 端到端升级，均以注入测试覆盖，生产首次升级需观察
  “pull 后验签失败”路径；`queue.test.ts` 仍静默吞掉 `runMigrations` 失败（历史写法，
  后续清理）。
