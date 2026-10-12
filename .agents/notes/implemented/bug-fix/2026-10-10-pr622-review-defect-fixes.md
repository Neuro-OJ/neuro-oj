# Agent Note: 修复 PR #622 题目版本管理审查发现的 56 项缺陷

Status: implemented

## Problem

PR #622 搭出了「不可变版本 + 共享草稿 + 评测尝试 + 有效成绩投影」的主体，但独立审查
（`dev-docs/reviews/2026-10-10-pr622-review-tracking.md`）发现 56 项缺陷与并发风险，
覆盖评测配置来源、存储留存、事务一致性、批任务恢复、客观题统计与客户端交付：

- **执行来源漂移**：默认题目详情、竞赛题面、客观题小题、模板下载、自测与 sweeper
  恢复在若干路径上仍读 `problems` 的「最新版投影」，出现「标记 V1、实际按 V2 判卷」；
  历史版本接口还绕过了运行配置的权限裁剪。
- **存储与删除**：产物在评测结束后被物理删除、上传补偿可直接删掉内容寻址共享对象、
  删除守卫的行锁与引用检查不在同一事务、`stat()` 异常被当成文件不存在、整题删除
  不是单事务且未处理竞赛固定版本外键。
- **草稿与发布**：新草稿接口绕过敏感字段权限与运行配置校验、客观题包导入能改已发布
  题型并提前改公开投影、文件引用修改不递增草稿 revision（可「检查 A 文件却发布 B 文件」）、
  `unchanged` 搜索全历史导致恢复旧内容无法发布、未知 SHA 以空串参与内容哈希、
  发布审计与搜索索引不在发布事务内。
- **存量迁移**：派生草稿只继承内容不继承文件引用；历史平台失败（SE/内部错误/AI 基础设施
  失败）被统一迁成正式有效判定，改变通过率分母与结算语义。
- **尝试与结果协议**：创建提交/尝试/活动指针不是一个事务；批重测未同步 `rejudge_seq`；
  结果封套校验不完整且被忽略的尝试仍可能产生副作用；非法评分 JSON 被 `unwrap_or(0)`/
  `clamp` 转成正式零分或满分并替换已有成绩；策略切换与结果写入没有统一锁顺序。
- **批任务与升级**：受理与附带策略变更不原子、策略作用域漏竞赛维度、先建尝试后做可能
  失败的准备、派发重试把自身在途尝试当成外部评测跳过、结果先到时找不到条目、升级重试
  重复生成提交、lease 不续租且过期 worker 可覆盖新 worker、网络失败被当成队列满。
- **竞赛与读取口径**：保存竞赛题目列表会重置有效策略；客观题榜单用最近分数而非有效
  成绩指针；结算不在一致性快照内且漏未启动的批任务；用 `result_status` 白名单判完成会
  把正式 TLE/CE 永久判为待处理；缓存 revision 不随成绩/策略变化递增、物化视图落后时
  反而不刷新、部分统计过滤运行状态导致重测期间已有成绩消失、客观题未纳入通过门槛。
- **客户端与 CI**：题目页只有版本徽标、提交详情缺少有效成绩与完整尝试历史、管理批重测
  界面三处功能缺陷、编辑器支持包上传可能创建另一道题、LMCC 扩展格式红灯。

## Decision

按缺陷类别分 6 条并行工作流执行修复，每条都以 `dev-docs/problem-version-management-handbook.md`
为权威规范，**拒绝以新增兼容回退掩盖不完整实现**：

1. **执行来源唯一化**：所有提交/自测/恢复路径从「已解析版本」构造完整执行上下文；
   新增 `catalog/services/versioning/version-read-view.ts` 作为统一的版本内容 DTO 与
   按字段裁剪入口（默认详情、历史详情、版本接口、竞赛题面共用）。
2. **存储守卫收敛**：登记行锁 + 全引用检查 + 物理删除在同一事务；只有明确 NotFound
   才置 `missing`；`deleting` 可续做、重传可在行锁内恢复 `ready`；产物保留到提交显式删除。
3. **草稿/发布一致性**：内容与文件引用共用一个 `revision`；发布在锁内重算内容哈希并与
   预检报告比对；审计与 `search_entries` 索引在发布事务内写入，Redis 通知降级为加速。
4. **迁移收尾**：新增 `drizzle/0109_legacy_platform_errors.sql`，把存量 `legacy_import`
   的平台失败改写为 `platform_error`、清空有效成绩投影并保留最近尝试；为已有草稿行补齐
   基线文件引用。同时把 `0108` 的赛期守卫改成与内联 `endedWindowCondition` 逐字一致
   （`~ 规范 ISO 正则` + `pg_input_is_valid`，fail-closed）。
5. **尝试/结果/锁协议**：统一尝试写入服务（提交+尝试+活动指针同事务）；尝试 `sequence`
   取 `max(MAX(attempt)+1, 提交行 rejudge_seq)`；结果强制可信 v2 封套并全量一致性校验，
   ignored 零副作用；core 与 Judge 双侧拒绝非法评分并保留已有判定；锁顺序严格按
   Handbook §5.1（题目 → 竞赛 → 提交 → 尝试 → revision）。
6. **批任务与读取口径**：受理、成员固定、策略与条目创建同事务；派发前完成
   `assertExecutionPreflight`（语言/模式/镜像白名单/资源/产物上限）；租约心跳 + owner
   条件更新；错误三分类；结算门禁纳入 `pending/preparing/dispatched`；有效统计一律以
   投影与有效尝试为准，两类提交统一聚合。

7. **测试夹具层的两个真实缺陷**（验收阶段用真实 PostgreSQL 全量回归才暴露，PGlite 下不可见）：
   - `shared/db/connection.ts`：连接池懒创建导致 `startRealTransaction()` 在测试进程**第一个触库用例**上直接返回，该用例不在事务内、写入自动提交（表现为固定 fixture id 的重复主键与 `current transaction is aborted` 级联）。改为先显式初始化连接池再 `BEGIN`；savepoint 名在同一连接上单调递增（不再随用例重置），并只忽略 `3B001`/`25P02` 这类记账竞态错误。
   - `query/services/rankings.ts`：结果写入后的 fire-and-forget `refreshRankingsView()` 会在测试长事务内**与用例的 savepoint 记账交错竞争**，导致 `savepoint "noj_sp_N" does not exist` → `current transaction is aborted` 的级联假失败。修复分两层：`connection.ts` 把同一条测试连接上的 savepoint 事务串行化，并让成功路径的 `RELEASE` 失败正常抛出（不再吞 `3B001`/`25P02`）；`refreshRankingsView()` 保留 `isInsideTestTransaction()` 短路作为**测试适配**（测试期读取本就走内联查询）；专门验证刷新的 `rankings-view-refresh.pg.test.ts` 关闭 preload 事务包装。
   - **根因勘误（2026-10-11）**：此处原先写作"`REFRESH MATERIALIZED VIEW CONCURRENTLY` 不允许在事务块内执行（PG 25001）"是**错误的**。PG 16.15 实测 `BEGIN; REFRESH MATERIALIZED VIEW CONCURRENTLY ...; ROLLBACK;` 成功；该语句允许在事务块内执行，`refreshRankingsView()` 的正式实现就是"同一事务内取 advisory lock → 刷新 → 记录 revision 与 materialized_at"。真正的问题是测试长事务里的 savepoint 交错，与 REFRESH 本身无关。

8. **第二轮复审（2026-10-11）10 项遗留缺陷**：
   - 存储引入**持久化上传预约**（`storage_object_reservations`）：物理上传前在登记行锁内预约，删除守卫见未过期预约即拒绝（409），登记只在持有自己的预约时才能从 `deleting/deleted` 恢复 `ready`——「删除在途 + 并发重传」不再产生 `ready` 但物理缺失的对象。
   - 批量策略修改改为**先按 ID 升序锁定全部题目、再锁定全部竞赛**（唯一实现 `lockEffectivePolicyHosts`），消除题目不相交/竞赛相交两批请求的 `40P01` 死锁。
   - LLM token 吊销收敛为**统一终态后处理** `revokeAttemptLlmTokens`（finished/error/superseded，四类终结路径都在事务提交后调用），TTL 由尝试快照推导而不再写死 3600s；`supersedeAttempt` 亦在提交后吊销。
   - 测试事务 savepoint 模拟修正：兄弟事务**串行化**、嵌套**不离队**、成功路径 `RELEASE` 失败必须抛出、回滚失败标记连接不可用。
   - 批任务改为**先完整预检并冻结快照、再单事务创建**副本/尝试/条目；锁内 `SOURCE_JUDGING`/`SOURCE_DELETED` 记为 `skipped`。
   - 升级副本插入同一事务内递增统计 revision；升级副本与普通提交**共享**用户额度（幂等键 = job item，限流总开关关闭时直接放行）。
   - 榜单新鲜度加入**赛期边界**维度（新增 `query_projection_revisions.materialized_at`），竞赛结束/改期即时失效。
   - 原生 PG 测试连接统一走 `tests/helper/pg-raw-connection.ts`（带 `TEST_SCHEMA` search_path），绑定检查与引用插入放入同一真实事务。

9. **第三轮复审（2026-10-11）10 项缺陷**：
   - 批任务 sequence 不再在预检阶段冻结，改由 `createAttempt` 在源行锁内统一分配，任务封套用**落库返回**的 sequence 回填（避免"落库 7 / 封套 0"导致结果被静默丢弃）。
   - 新增 LLM token 吊销 **outbox**（`llm_token_revocations`，迁移 `0112`）：在写终态的同一数据库事务内登记 pending，提交后立即执行、失败由 sweeper 周期持久化重试；finished / error / superseded 三条路径共用，进程退出也不丢吊销。
   - 测试事务 savepoint 模拟改用 `AsyncLocalStorage` 按**事务节点**判定父子：同父子事务按序、链外兄弟排队、外层 RELEASE 前排空子队列。
   - 榜单刷新覆盖时间改用刷新事务的 `transaction_timestamp()`，与视图 `now()` 同源，消除"等锁跨赛期边界"时的误判可信。
   - 升级额度占位与扣费合并为**单次原子 EVAL**（标记只在扣费成功后写入）；额度按 `code` / `contest_code` / `objective` 与实际提交**同桶同阈值**。
   - artifact 流式上传改为**上传后在登记行锁内真实 stat 复核**，据此恢复 `ready` 或拒绝绑定。
   - 客观题重判/升级的源竞争在源行锁内复查并统一归入 `skipped`（SOURCE_DELETED / SOURCE_JUDGING）。
   - 双分片前串行初始化数据库级公共扩展（advisory lock + `WITH SCHEMA public`），消除全新库上 `pg_trgm` 并发创建的 23505 竞争。

**口径决策（记录在案）**：

- 队列网络失败在**批任务条目层**使用 1/2/4/8/16s 有界退避；直提路径维持「保留 pending +
  sweeper 重派」，不新增 schema 重试列、不引入进程内计数（遵守多副本约束）。
- 全站排行 `total_submissions` 与视图口径一致：整体共用竞赛可见性过滤（而非「用户全部提交数」）。
- 已发布版本的执行预检（语言/镜像/资源/产物上限）在直提与批任务两条路径共用同一 helper，
  避免两套口径漂移。

## Alternatives considered

- **保留最新版投影作为兼容回退**：会让「V1 提交按 V2 判卷」长期存在，直接违反 Handbook
  §2.2「版本记录是内容事实来源」，因此明确拒绝。
- **把 unpublished 题目回退为 `legacy_unknown`**：迁移已完成，允许线上新建未知版本提交会
  重新引入无法归因的成绩，改为全部入口无条件要求显式已发布版本。
- **直提路径也加有界退避计数列**：需要新增 submissions 列与多副本语义，收益（网络故障终态化）
  不足以抵消 schema 与多副本风险；改由 sweeper 持续重派保证不丢提交。
- **编辑既有迁移 `0104` 修正视图口径**：`0104` 已被 `0108` 取代，回改会造成重复；选择只修
  `0108` 并保留 `0104` 的历史形态。
- **测试夹具层的事务隔离问题一并修复**：`tests/preload.ts` 的真实 PG 事务代理在「文件首个
  触库用例」前未 BEGIN，属既有测试基础设施问题（产品代码无关），本轮以
  `disableTestTransactionForFile()` 在真实 PG 并发用例中规避，未扩大改动面。

## Consequences

- 「提交时版本 = 实际执行版本」在代码、恢复、批任务三条链路上闭环；历史版本接口与默认
  详情共用同一裁剪，匿名/普通/编辑者/管理员敏感字段集合一致。
- 有效成绩与运行状态解耦：重测中、平台错误都不会让已有正式判定消失；策略切换在同一事务内
  立即生效并递增 `global` revision，不依赖 TTL 或异步视图刷新。
- 存量库升级会把历史平台失败从「正式判定」改写为「平台错误」，因此通过率分母与结算语义
  会向 Handbook §3.3 收敛；迁移 `0109` 幂等且可重复执行。
- 发布、文件引用与内容哈希绑定同一 revision；「检查 A 发布 B」不再可能。
- 新增真实 PostgreSQL 用例覆盖锁/租约/外键/迁移场景：
  `tests/db/pr622_review_migration_test.ts`、`versioning-lock-order.pg.test.ts`、
  `versioning-job-concurrency.test.ts`、`contest-settlement-consistency.pg.test.ts`、
  `rankings-view-refresh.pg.test.ts`；这些用例在无 `DATABASE_URL` 时按项目约定静默跳过，
  静默跳过基线已随之更新。
- 测试夹具的隔离语义已修正：真实 PG 下每个用例（含进程内第一个触库用例）都在真实事务内
  执行；物化视图刷新在测试事务内不执行，需要验证刷新本身的用例改用
  `disableTestTransactionForFile()`。修复后真实 PG 域回归全绿（submission 279 passed /
  0 failed，`scripts/test-shared.sh` 294 passed / 0 failed）。
- 跨模块 E2E 仍未在本环境运行：`noj-tests` 需要完整 E2E 栈（端口 8099），本环境的 Docker
  builder 目录只读导致镜像无法构建，需由 CI 的 `e2e.yml` 或具备可写 builder 的环境执行。
