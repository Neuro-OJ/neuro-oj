# Neuro OJ 系统架构评审（2026-09-12）

> 状态：评审结论 / 建议草案（未提交、未改动任何代码）
> 基线：当前工作区 HEAD（`wlxwyvzlzzsv`，含 #502 公测运维与题目质量预检）
> 范围：全栈架构、模块边界、可靠性、安全、工程治理、部署运维
> 方法：静态阅读 + 独立复现关键缺陷 + 与 `architecture-review-2026-09-01.md` 交叉复核
> 原则：每条结论都给出可验证的 `path:line`；subagent 提出的高危项均由本人重新核对后才收录；
> 已剔除 2 条经复核不成立的结论（见 §7「对本次评审的自我更正」）。


---

## 0. 修复状态（2026-09-12 执行，本文档发布后同日完成）

> 本节由执行修复的同一会话补充。每条都指向可复现的验证方式；
> 门禁全部接入 `scripts/check-ci.ts`（`deno run -A scripts/check-ci.ts` 一次跑完）。

| 条目 | 状态 | 落地内容与验证 |
| --- | --- | --- |
| §2.1 迁移 0080 | ✅ 已修 | 0080 改为三步式（加可空列→按 `created_at`/`banned_at` 回填→`SET NOT NULL`）；新增 `tests/db/migration_0080_backfill_test.ts`（在有数据的表上执行真实迁移文件，PGlite + PG 双模式通过）与 `scripts/check-migration-safety.ts` 静态门禁 |
| §2.2 `append_capped` | ✅ 已修 | 截断点对齐 UTF-8 字符边界并成为硬上限；4 条单测（含 1800 字节中文块 ×1000 轮）。用 `rustc` 复刻旧实现确认其必 panic |
| §2.3 capability-seam 假绿灯 | ✅ 已修 | 白名单路径改为真实路径、按导入文件目录解析、覆盖动态 `import()`、加 4 条自检（含"恒真断言"检测）；结论：修复前解析到 0 处 Provider 引用，修复后 8 处 |
| §2.4 占位 JWT 密钥 | ✅ 已修 | 新增 `src/shared/security/secret-placeholders.ts`（单一事实源），`main.ts` 对 `JWT_SECRET`/`TFA_ENCRYPTION_KEY` 启动期拒绝占位值；`.env.prod.example`/`.env.example` 密钥项改为留空 |
| §2.5 消费队列恢复缺口 | ✅ 已修 | `createConsumer` 启动时自愈本队列 `:processing`（每进程每队列一次）；sweeper 改为遍历 `createConsumer` 自动登记的 `sweep-targets`；关闭标记改为每实例独立 |
| §2.6 多副本状态 | ✅ 已修（部分） | 设置变更广播 `noj:events:settings`，各副本**重新加载**（注意：`getSetting` 未命中不回查 DB，只删缓存会读到默认值）；`domain-boundaries.md` 新增「多副本约束」清单，其余项登记为单副本专用 |
| §3.1 JudgeTask 契约 | ✅ 已修 | 6 处内联构造收敛为 `buildJudgeTask()`；两侧共用 `noj-tests/fixtures/judge-task.contract.json` 快照（TS + Rust 各一套断言）；修正 `types.rs` 3 处失效路径注释 |
| §3.2 巨型文件 | ✅ 已加棘轮 | `scripts/check-file-size.ts`：存量 5 个超限文件登记基线，**任何增长即失败** |
| §3.3 schema-ddl 漂移 | ✅ 已修（**并推翻本文 §3.3 的原结论**） | 自动化 parity 门禁 `noj-core/scripts/check-schema-parity.ts` 发现真实漂移：`roles.is_admin` 陈旧列（迁移 0032 已删）、3 张 RBAC 表被误放在 `SCHEMA_INDEXES`。修复后 54 表 / 433 列一致 |
| §3.4 路由目录 | ✅ 已修 | 正则锚定接收者 + 路径须以 `/` 开头；365 行（112 行伪造）→ 253 行（0 伪造）；新增下限断言与单测 |
| §3.5 指标 catalog | ✅ 已修 | `check-metrics.ts` 真正解析文档并双向比对；补齐 12 个缺失平台指标（35 个全覆盖） |
| §4.1 OAuth 302 | ✅ 已修 | 非 SSE 分支补 `fetchOptions: { redirect: 'manual' }`；新增源码级回归测试（每个 `proxyRequest` 调用点都必须声明该语义） |
| §4.2 sitemap 投毒 | ✅ 已修 | 权威域名 `NUXT_SITE_URL` 优先、缓存按 origin 分键、降级结果不写缓存、加 `cache-control` |
| §4.3 结果信任边界 | ✅ 已修 | `sanitizeJudgeResult()`：score clamp/status 白名单/负数与非法 time·memory 清零/output 类型与上限 |
| §4.4 镜像 digest | ✅ 已修 | `parseImageRef()` + 白名单登记 digest 后按 digest 匹配（未登记时保持历史语义，向后兼容） |
| §4.5 迁移并发 | ✅ 已修 | `runMigrations()` 外层 advisory lock（**独立锁连接**——曾因从主池 `reserve()` 造成自死锁，已写入注释）；并发验证：第二个迁移器等待，82 条迁移全部落库 |
| §4.6 限流漏加 | ✅ 已加门禁 | `scripts/check-write-rate-limits.ts`：写路由文件必须有证据或在白名单登记，当前暴露 3 项欠债（checkin/users/email-delivery） |
| §5.1 静默跳过 | ✅ 已修 | 报告脚本加 `--check` 与基线（515 处），**增长即失败**；扫描器空转也会失败 |
| §5.2 compose 资源与日志 | ✅ 已修 | 全部 10 个服务补 `mem_limit` + json-file 轮转；judge **不加**假 healthcheck（原因写在 compose 注释里） |
| §5.3 监控与键名 | ✅ 已修 | 新增 `--profile monitoring`（prometheus + alertmanager，digest 钉死、只绑回环）；`RUNTIME_LLM_GATEWAY_URL` 在 compose 显式设为 `http://llm-gateway:8001`（默认值里的 `noj-llm-gateway` 在生产不解析） |
| §5.4 运维测试进 CI | ✅ 已修 | `test-deploy.sh` / `test-backup.sh` / `test-restore-drill.sh` 接入 `check-ci.ts` |
| §5.5 文档漂移 | ✅ 已修（部分） | 09-01 评审加修订指针；表数量 38→54；`users.role` 已删除；noj-ui 测试/命名更正；推送策略矛盾统一到顶层 AGENTS.md；`noj-core/AGENTS.md` 与 `CLAUDE.md` 收敛为同一份（symlink）；新增「文档时效约定」 |
| 顺带修掉的门禁缺陷 | ✅ | `verify-export-jsdoc`（0 导出曾判 100% 通过）、`verify-md-links`（曾扫描代码块造成误报 + 空转通过）、`verify-domain-ci`（jj 工作区回退遍历未跳过 `node_modules`） |

**执行中发现并部分修复的预存在问题（如实记录）**

- **MQ 假 Redis 测试的进程级 env 污染（未完全修复）**：`src/domains/submission/tests/`
  下多个文件用 `Deno.env.set("REDIS_URL", fake.url)`（`startFakeRedis()` 监听
  `port: 0`，随机端口）把生产路径指向 fake Redis，而同一分片内的测试文件是**并行**的
  → 伪造窗口内其他文件读到假端口，`getRedis()` 被重建后连到不存在的地址
  （日志实证：`connect ECONNREFUSED 127.0.0.1:39185` → `Connection is closed.`），
  搜索索引事件发布失败 → 分片全量运行随机出现 2 个假失败（单文件运行必过）。
  已做的部分修复：新增 `createRedisClientForUrl()` 并把 `consumer.test.ts` 改为显式
  URL（不再改 env）；`publishSearchIndexEvent` 在连接未就绪时先确保连接（消除静默丢
  事件）；移除 8 个 search-events 测试里互相删除 `noj:search:index` 的竞态。
  **剩余工作**：`producer.test.ts`(6 处) / `self-test-consumer.test.ts`(2 处) /
  `submissions.test.ts`(3 处) / `legacy-judge-queue.test.ts`(1 处) /
  `revokedTokens.test.ts`(1 处) 仍改进程级 env；正确修法是把 URL 作为显式 seam 注入
  消费/生产工厂（而不是改全局 env），或让这些文件串行执行。
- **`publishSearchIndexEvent` 仍是 fire-and-forget**：本次只加了"未就绪时补连接"，
  没有加对账/重放；索引落后仍无自动化发现（§2.5 的原始建议）。

**未处理/留给下一轮**：judge 的容器级健康探针（需先在 judge 内实现自检子命令）、
`stats-cache`/`banCache`/限流计数等进程内状态的 Redis 化、`dual/mod.rs` 拆分、
`check-write-rate-limits` 暴露的 3 项限流欠债。

---

## 1. 总体结论

项目已进入"工程化成熟期"，**不需要推倒重来**。与 2026-09-01 评审相比，进步显著：

- 8 月审计的高危项基本闭环；上一版评审 §3.2（LLM 数据所有权）、§3.4（事务性 Outbox）、
  §5.2（沙箱纵深）多数已真实落地，而非停留在文档；
- 一批"只写在注释里的约束"被提升为**运行时门禁与 CI 校验**（`check-domains`、`check-metrics`、
  `gen-route-catalog --check`、`verify-domain-ci`、Agent Note 格式校验等 20 条）；
- 前端从"无测试"变为 30 个测试文件并接入 CI；`$fetch` 直调已清零。

但当前主要矛盾已不是"有没有做"，而是**"声称做了、实际没生效"**。本次评审发现的最有价值的
一类问题，是**门禁与检查工具的"假绿灯"**：脚本存在、进 CI、打印"校验通过"，但其判定条件
已因代码重构而永久失效或从未正确锚定。这类缺陷比没有门禁更危险，因为它同时消除了
"人工复核"与"自动拦截"两条防线。

第二个系统性主题是**"升级路径"缺乏验证**：测试与 CI 只覆盖"空库全新安装"，
存量部署的迁移、回滚与降级路径没有等价的门禁（§3.1 即由此漏出）。

第三是**多副本假设未成立**：多处进程内状态没有跨副本失效通道（§4.1）。

---

## 2. 必修项（建议进下一个迭代）

### 2.1【严重 · 可致全站停机】迁移 0080 在存量库上必然失败

**证据**

```sql
-- noj-core/drizzle/0080_woozy_romulus.sql:1-4
ALTER TABLE "community_reports"   ADD COLUMN "updated_at" text NOT NULL;
ALTER TABLE "community_sanctions" ADD COLUMN "updated_at" text NOT NULL;
ALTER TABLE "ip_bans"             ADD COLUMN "updated_at" text NOT NULL;
ALTER TABLE "user_bans"           ADD COLUMN "updated_at" text NOT NULL;
```

四条 `ADD COLUMN ... NOT NULL`，**既无 `DEFAULT` 也无回填**。已核实：

- 四张表的建表语句（`0014_ip_bans_and_user_ban.sql`、`0015_user_bans.sql`、
  `0029_bizarre_mentallo.sql`）**均不含 `updated_at`**，即该列此前不存在；
- 四张表在运行时必然有数据：`community-moderation.ts:162,543`、`banlist.ts:123`、
  `users-bans.ts:134` 均有 `insert`；
- drizzle 的 migrator 把**全部待执行迁移包在单个事务**里
  （`drizzle-orm/pg-core/dialect.cjs:60-71`），失败即整批回滚；
- `migrate` 服务非零退出 → `core` 因 `depends_on: migrate: service_completed_successfully`
  （`docker-compose.prod.yml:84-86`）**永不启动 = 全站不可用**。

**为什么 CI 没拦住**（这是本条最有价值的部分）

唯一执行文件迁移的测试跑在**空库**上（`noj-core/tests/00_migrate_test.ts`），
而 PostgreSQL 允许空表加 `NOT NULL`；这四个表也从未被任何 seed 或迁移写入。
因此**全新安装通过、只有存量升级会炸**——恰好是最需要保护、又最难在 CI 覆盖的路径。

**建议**

1. 改为三步式：`ADD COLUMN ... NULL` → `UPDATE ... SET updated_at = created_at`（或 `now()`）
   → `ALTER COLUMN ... SET NOT NULL`；
2. 新增**升级路径门禁**：CI 中先迁移到 `0079` 并回填代表性数据，再执行剩余迁移。
   这是本次评审优先级最高的"补测试"建议；
3. 迁移评审清单加一条硬规则：**禁止新增无 DEFAULT 的 NOT NULL 列**，可用脚本静态拦截。

---

### 2.2【严重 · 中文评测确定性丢结果】`append_capped` 在 UTF-8 字符边界 panic

**证据**

```rust
// noj-judge/src/dual/mod.rs:144-151
fn append_capped(buf: &mut String, s: &str) {
    if buf.len() + s.len() > MAX_OUTPUT_BYTES {
        let keep = MAX_OUTPUT_BYTES.saturating_sub(s.len());
        let start = buf.len().saturating_sub(keep);
        *buf = buf[start..].to_string();   // start 可能落在多字节字符内部 → panic
    }
    buf.push_str(s);
}
```

**已独立复现**（脱离仓库，用 `rustc -O` 单独编译复刻函数）：以 1800 字节的中文块反复追加，
在第 349 次迭代 panic：

```
byte index 1424 is not a char boundary; it is inside '：' (bytes 1422..1425 of string)
```

触发条件是**累计输出超过 1 MiB（`MAX_OUTPUT_BYTES`，`dual/mod.rs:39`）且截断点落在多字节
字符内部**。中文评测输出满足该条件是常态，不是理论风险。

**影响链**（比 panic 本身更严重）

9 个调用点全部位于评测主循环（`dual/mod.rs:894,895,923,936,937,975,976,980,981`）；
panic 发生在 `tokio::spawn` 的任务内，`JoinHandle` 的 `Err` 只被 `error!` 记录
（`main.rs:428-432`）→ **结果永不推送、任务永不 ACK** → 提交永久停在 `judging`，
被 core sweeper 重投后再次 panic，形成无限循环。

**建议**

```rust
let mut start = buf.len().saturating_sub(keep);
while start < buf.len() && !buf.is_char_boundary(start) { start += 1; }
```

或改用 `Vec<u8>` 累积、仅在输出时做 lossy 转换（更彻底，且天然规避同类问题）。
补一条"含中文 + 超 1 MiB"的回归单测——现有 9 个调用点**零单测覆盖**。

---

### 2.3【高】`verify-capability-seams.ts` 是永久空转的假绿灯

**证据**：脚本硬编码的 5 个 Provider 路径与 4 个装配点白名单
（`scripts/verify-capability-seams.ts:7-21`）**全部指向已不存在的旧目录结构**：

| 脚本中的路径 | 实际情况 |
|---|---|
| `lib/storage/local.ts` / `lib/storage/s3.ts` | 已迁至 `domains/system/services/storage/` |
| `lib/email-providers/{mock,aliyun,tencent}.ts` | 已迁至 `domains/system/services/email-providers/` |
| `lib/email.ts`（装配点） | 已迁至 `domains/system/services/email.ts` |

判定用精确字符串相等（`spec === provider`），路径失效后**永不为真**。
实测输出 `Capability Seam 校验通过`，且真实接入 CI（`scripts/check-ci.ts:10` → 每个 PR 都跑）。
即：**架构红线零守护，却报绿**。

**建议**：修正路径白名单；把"白名单中的每个路径必须真实存在，否则门禁失败"作为该脚本的
第一条自检——这能同时防住同类漂移。**并建议对 `check-ci.ts` 其余 19 条做一轮同类审计**
（本次只逐一验证了这一条）。

---

### 2.4【高】占位 JWT 密钥可通过启动校验

**证据**

```
.env.prod.example:58  JWT_SECRET=change-me-to-a-random-string-at-least-32-chars   ← 46 字符
noj-core/src/shared/base/constants.ts:15  MIN_JWT_SECRET_LENGTH = 32
noj-core/src/main.ts:113-114  仅做长度校验
```

compose 的 `:?` 只拦空值。`docker-compose.prod.yml` 头部推荐的手动路径
（`cp .env.prod.example .env.prod` → `vim` → `up -d`）**没有** `is_placeholder` 兜底——
该兜底只存在于 `scripts/deploy/deploy.sh:688`（`check_required_values` 会拒绝占位值，
且 `deploy.sh:625-637` 会直接生成强随机密钥）。

**影响**：使用公开已知密钥部署，可伪造任意用户（含 admin）的 token。

**建议**：① 启动校验加占位符黑名单（含 `change-me`、`your-`、`example` 等）；
② 首选项是让 compose 头部改为推荐 `deploy.sh`，或把 `deploy.sh` 的占位值检查提取为
可被 core 复用的共享校验；③ `.env.prod.example` 该行改为显式空值，强制部署者填写。

---

### 2.5【高 · 长尾丢数据】消费队列的恢复机制存在系统性缺口

评测结果队列（`noj:judge:results`）有完整的 `processing` + sweeper + 死信 + 幂等语义，
**但同一套 `createConsumer` 基类被另外两个消费者复用时，配套的 sweeper 没有跟上**：

| 消费者 | 队列 | `:processing` 有 sweeper 兜底？ |
|---|---|---|
| 评测结果 `submission/mq/consumer.ts` | `noj:judge:results` | ✅ `sweeper.ts:624` |
| 搜索索引 `search/consumer/search-index-consumer.ts` | `noj:search:index` | ❌ |
| 私信审核 `content-review/mq/review-consumer.ts` | `noj:review:dm` | ❌ |

`sweeper.ts:611-617` 的队列列表只含三级评测队列 + 结果队列。
配合 `base-consumer.ts:98` 的 `BRPOPLPUSH` 语义：**消费者在"已取走消息、未 ACK"窗口内
进程被杀（或 Redis 连接中断），消息永久停留在 `noj:search:index:processing`**。
搜索索引是异步投影，源域写库成功后以 fire-and-forget 方式投递
（`shared/search-events.ts:36-50`），**没有任何对账/重建自动化**——
`reindexAll()` 存在但只挂在手动 CLI（`scripts/noj.ts:322`）。

即：搜索索引会**静默地、不可自愈地**落后，直到有人手工执行 `search reindex`。

**建议**

1. 把 sweeper 泛化为覆盖所有 `createConsumer` 队列（或让 `createConsumer` 自带
   "启动时重投本队列 `:processing`"的逻辑——这样新消费者自动获得兜底）；
2. 索引类投影增加**周期性对账**（比对源表 `updated_at` 与索引，差异大时告警）；
3. `base-consumer.ts:23` 的全局 `consumerShutdownRequested` 是**三个消费者共享**的
   单一布尔量，任一消费者触发关闭会同时停掉其余两个。当前只有
   `requestResultConsumerShutdown()` 会被调用（`main.ts:282`）尚不致病，
   但这是脆弱耦合，建议改为每实例独立标记。

---

### 2.6【高 · 多副本不可用】进程内状态缺少跨副本失效通道

当前单副本部署（`docker-compose.prod.yml` 无 `deploy.replicas`）掩盖了一批
"只在多副本下暴露"的问题。若按路线图 K8s 化，以下会立即成为线上事故：

| 位置 | 状态 | 多副本后果 |
|---|---|---|
| `system-settings.ts:87` | 全量设置内存 `Map` | **A 副本改设置，B 副本永不感知**（无失效频道） |
| `stats-cache.ts:51-56,133,139` | 站点统计计数器 | 各副本自增，`/stats` 结果随负载均衡抖动 |
| `sweeper.ts:49-50` | `_firstSeen`/`_lastRequeue` | 重复重投判定失准，可能双份投递 |
| `banCache.ts:22` | 封禁缓存 60s | 封禁生效延迟不一致 |
| `system/middleware/rate-limit.ts:29` | 限流计数 | 限流阈值被放大 N 倍（该文件已在注释中自认此限制） |
| `rankings.ts:91-92` | 物化视图刷新节流 | 各副本各刷一次 |

关键证据：`shared/sse/event-bus.ts:15-38` 的 `Channels` **没有 settings/配置失效频道**，
`system-settings.ts` 的失效全部是本地 `cache.delete()`（`:545,609,640,716`）。

**建议**（低成本的正确顺序）

1. 先加**设置失效广播**：`updateSetting` 成功后向 Redis 发一条
   `noj:events:settings` 事件，各副本订阅后清本地缓存。这是唯一会立刻造成
   "管理员改了但部分用户行为不一致"的一类；
2. 统计计数器改由 Redis `INCR` 承担（或干脆改为按需查库 + 短 TTL 缓存）；
3. **在 `AGENTS.md` / `domain-boundaries.md` 中显式写下"多副本约束"**：
   新代码禁止新增进程内可变状态，除非标注"单副本专用"。
   本次评审发现多处"注释里写了限制、但没有规则约束后来者"的模式，
   补一条全局约定比逐个修复更有价值。

---

## 3. 结构性问题（中期）

### 3.1 跨模块契约靠人工镜像，无一致性校验

`JudgeTask` / `JudgeResult` 在两侧各写一份，且注释互相指认对方为"对齐"依据：

- TypeScript：`noj-core/src/domains/submission/types/index.ts:19-45`
- Rust：`noj-judge/src/types.rs:76-118`（注释："字段对齐 noj-core/src/types/index.ts 的 JudgeTask 接口"）
  —— 已核实 `noj-core/src/types/index.ts` **目录已不存在**，
  该注释在 `types.rs:27,73,117` 三处均指向失效路径，说明两侧对齐是纯人工约定

且 `JudgeTask` 没有单一的构造入口——**6 处内联构造**：
`submissions-crud.ts:477`、`submissions-rejudge.ts:156,375`、
`artifact-submissions.ts:303`、`self-tests.ts:139`、`sweeper.ts:273`。
新增字段需同时改 6 处 + 1 个 Rust 结构体，靠人工记忆。

无 codegen、无契约测试（`rg "JudgeTask" noj-tests/` 零命中）。
失败模式是**静默的**：Rust 侧 `#[serde(default)]`/`Option` 会把缺失字段化为默认值，
core 加了字段而 judge 不认时不会报错，只会行为异常。

**建议**

1. 立即可做：把 6 处内联构造收敛为**一个工厂函数**（如 `buildJudgeTask()`），
   字段新增只改一处；
2. 中期：从 TS 类型生成 JSON Schema，Rust 侧用它做反序列化校验（或直接用
   `schemars`/`serde_json::from_value` 严格模式 + `deny_unknown_fields`）；
3. 加一条**契约快照测试**：序列化一份样例 `JudgeTask`，两侧断言同一份 fixture。

### 3.2 巨型文件仍在增长（上一版评审 §4.1 未改善）

| 文件 | 行数 | 上一版评审 |
|---|---|---|
| `noj-judge/src/dual/mod.rs` | **2146** | 1662 → **恶化** |
| `noj-ui/pages/messages/index.vue` | 1631 | — |
| `noj-core/.../messaging/services/messages.ts` | 1514 | — |
| `noj-core/.../settings-registry.ts` | 1359 | —（注册表，可接受） |
| `noj-core/.../contest-similarity.ts` | 1314 | — |
| `noj-core/src/shared/db/schema-ddl.ts` | 896 | — |

`dual/mod.rs` 拆分出的 `tracker.rs`/`protocol.rs` 只搬走了纯逻辑，**编排状态机仍在膨胀**。

**建议**：把 `dual/mod.rs` 按"容器生命周期准备 / 帧路由 / 超时与收尾"三段拆分；
`messages/index.vue` 按"会话列表 / 消息流 / 输入区"拆组件。
建议增设 CI 阈值（单文件 > 1200 行告警），防止继续漂移。

### 3.3 `schema-ddl.ts`：一份手工镜像 schema，且只用于测试

`noj-core/src/shared/db/schema-ddl.ts`（896 行）是 Drizzle schema 的**手工 SQL 副本**，
仅供 PGlite 测试模式建表（`shared/db/connection.ts:513`）。

本次**逐表逐列比对**了 54 张表：**表集合与列集合完全一致**（无真实漂移），
维护纪律意外地好。但风险结构没有改变：

- 无任何自动化 parity 校验（`tests/db/schema.test.ts` 只断言少量列，且是断言
  Drizzle 侧而非两侧一致）；
- 一旦漂移，症状是**测试通过与生产行为不一致**（测试跑在手工 SQL 上），
  比测试失败更危险。

**建议**：二选一——① 删除手工 DDL，PGlite 模式改为直接跑 `drizzle/*.sql` 迁移文件
（PGlite 支持大部分 DDL，个别不支持的语句单独处理）；② 保留但在 CI 中生成
Drizzle 的表/列清单并与 DDL 解析结果比对。**方案①更优**，因为迁移文件本来就是
生产唯一事实源，让测试与生产共用它能一并消除这类风险。

### 3.4 路由目录 31% 是伪造条目，且 `--check` 无法发现

`dev-docs/engineering/route-catalog.md` 由 `scripts/gen-route-catalog.ts` 生成并进 CI
（`--check`）。但其正则（`:53`）**未锚定接收者**：

```ts
const re = /\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
```

于是 `c.get("userId")`、`Deno.env.get("NOJ_ENV")` 都被当成路由。实测 365 行中
**112 行（31%）路径不以 `/` 开头**：`userId` × 93、`userRole` × 9、`NOJ_ENV` × 5、
`jti` × 2 等。

`--check` 只校验"文件与生成结果一致"，**不校验生成结果是否正确**，故持续放行。

**建议**：正则锚定为 `(?:router|app|[a-zA-Z]+Router)\.(get|post|...)`，
并把生成的路径限定为以 `/` 开头；同时给生成器加"解析出的路由数不得低于近期基线"
的下限断言（防止重构后批量失配却静默通过）。

### 3.5 指标 Catalog 声称被校验，实际无程序读取

`dev-docs/engineering/metric-catalog.md:3` 自称"由 `scripts/check-metrics.ts` 校验"，
但**全仓搜 `metric-catalog` 零命中**——该脚本读的是 `platform.ts` 的注册表，
从不打开此文档。实际注册 **35** 个平台指标，文档只列 **30** 个，
缺失项包含告警规则直接依赖的指标。

**建议**：让 `check-metrics.ts` 真正解析并比对文档表格（与 `gen-route-catalog` 同构）；
或把该文档改为生成产物（推荐，消除人工维护面）。

---

## 4. 安全与可靠性补强

### 4.1【高】OAuth 登录流在启用后不可用（非-SSE 代理分支缺少 `redirect: 'manual'`）

**证据链**

- 浏览器发起导航：`noj-ui/pages/login.vue:269`
  `window.location.assign('/api/v1/auth/oauth/${provider}')`
- core 正常返回 302：`noj-core/.../routes/auth.ts:409` `return c.redirect(result.url, 302)`
  （并在同一响应写 state Cookie，用于回调时校验，`:404`）
- Nitro 代理的**非 SSE 分支**直接 `await proxyRequest(event, target)`
  （`noj-ui/server/api/[...slug].ts:333`），**未传 `fetchOptions`**；
  而 SSE 分支**显式**设了 `redirect: 'manual'`（`:125`）——作者知道该语义，只覆盖了 SSE。
- h3 的 `sendProxy` 用 ofetch 且把选项透传给 `fetch`
  （`h3/dist/index.mjs:1176-1184`），ofetch 不设 `redirect` 默认值
  （`ofetch/dist/shared/ofetch.CWycOUEr.mjs:274`），故按平台默认 **`follow`**。

**后果**：代理自己跟随 302 到 GitHub/OIDC，把对方页面回吐给浏览器；
浏览器停留在 `/api/v1/auth/oauth/:provider`，永不进入回调端点
（state 校验与 `Set-Cookie` 所在处），OAuth 首次登录 100% 失败。
同类事故有先例：`.agents/notes/implemented/bug-fix/2026-09-11-nitro-proxy-status-coercion.md`
（当时只修了状态码，未覆盖重定向）。

**影响面**：OAuth 为**可选启用**（`login.vue:74` 仅在 `oauthProviders.length` 时渲染按钮），
`.env.prod.example:24-29` 默认留空，故当前多为潜伏缺陷；但一旦配置即完全不可用。
`rg oauth noj-tests/` 零命中——**无任何测试覆盖**。

**建议**：非 SSE 分支补 `proxyRequest(event, target, { fetchOptions: { redirect: 'manual' } })`；
补一条回归测试（断言 302 与 `location` 被原样透传）。**这类"代理语义"缺陷值得一次性
系统性排查所有 h3/ofetch 透传点**，而不是逐个修。

### 4.2【中】sitemap 把请求 Host 写入进程级缓存（缓存投毒）

```ts
// noj-ui/server/routes/sitemap.xml.ts
let cache: { at: number; body: string } | null = null;        // :8  进程级
const host = event.headers.get('host') ?? 'localhost:3000';    // :53 请求头
const origin = `${protocol}://${host}`;                        // :54
...
cache = { at: now, body };                                     // :84 写缓存（TTL 1h，:4）
```

`origin` 派生自**请求头**却写入**进程级**缓存。伪造一次 `Host` 即可把
`<loc>https://evil.com/...</loc>` 钉住 1 小时，影响所有用户与搜索引擎。
附带：无 `Cache-Control`；catch 分支的降级结果同样被缓存（`:74-76`）。

**建议**：用配置的权威域名（`APP_URL`/runtimeConfig）构造 origin；
若必须支持多域名则把 host 纳入缓存 key 并做白名单校验；降级结果不写缓存。

### 4.3【中】core 对 judge 回传结果不做自主校验（信任边界）

`saveEvaluationResult`（`submissions-result.ts:161-167`）直接写入 `result.score`：

```ts
await tx.insert(evaluationResults).values({ ..., status: result.status, score: result.score, ... });
```

judge 侧已做 clamp（`dual/mod.rs:1235-1239`，限定 0..10000），所以**当前不可利用**。
但 Redis 队列是 core↔judge 之间的信任边界，core 对 `score`/`status`/`time_ms`
**零校验**——一旦 judge 版本回退、被替换或队列被其他主体写入，脏分数会直接进入
榜单与竞赛排名 SQL（`contest-ranking.ts:322-416` 直接用 `er.score`）。

**建议**：在 `saveEvaluationResult` 入口做一次防御性归一
（`score` clamp、`status` 白名单、`time_ms/memory_kb` 拒绝负值），与
`sanitizeJudgeDetails`（`consumer.ts:62-83`，已对 details 做了白名单化）保持同一严格度。
这是低成本、纯收益的纵深防御。

### 4.4【中】镜像白名单按 tag 匹配，非 digest

`isImageInWhitelist`（`noj-core/src/domains/catalog/types/problems.ts:278-290`）在
`mode === "all_versions"` 时用 `stripImageTag(image) === stripImageTag(entry.image)`
比较——即**忽略 tag**。对可变的 tag（如 `latest`、或仓库被覆盖推送的同名 tag），
白名单无法保证"跑的还是当初审核过的那个镜像"。

**已做对的**：judge 的 4 个基础镜像 Dockerfile 全部 `FROM python:3.12-slim@sha256:...`
（digest 钉死），容器加固完整（见 §6）。

**建议**：把评测镜像白名单升级为 **digest 白名单**（或 `tag@digest` 双写），
在 core 侧校验时要求 `runtime_config.*.image` 含 digest；`all_versions` 语义可保留为
"同 repository 的任意 digest 均需在库中登记"。

### 4.5【中】迁移无并发保护

`shared/db/migrate.ts` 的 `runMigrations()` 既被 `main.ts:141` 在启动时调用，
也被独立的 `migrate` 服务调用（`docker-compose.prod.yml:59-72`）。
已核实 drizzle 的 migrator **不加 advisory lock**
（`drizzle-orm/pg-core/dialect.cjs:44-72` 只有建表 + 单事务）。
当前靠 `depends_on` 串行化，单副本安全；多副本或人工并行执行会竞争。

**建议**：在 `runMigrations()` 外层包 `pg_advisory_lock(<常量>)`，
使并发迁移天然串行且幂等。成本极低，是水平扩展的前置条件。

### 4.6【低】限流矩阵已很完整，但缺"新增端点自动提醒"

`dev-docs/engineering/write-rate-limit-matrix.md` 覆盖面很好（auth/提交/自测/竞赛/
社区/私信/题目导入均有 hardening 限流），且明确列出"已知不覆盖"项。
唯一缺口是：**新端点漏加限流没有自动发现机制**（矩阵靠人工维护）。

**建议**：加一条静态检查——扫描 `routes/` 下所有写方法路由，
若既无 `hardeningRateLimit*` 也无白名单标注则告警（与 `check-domains` 同思路）。

---

## 5. 工程治理与运维

### 5.1【高】静默跳过使"测试通过"失去意义

- `noj-tests/e2e/helper.ts:502`：`ignore: !isE2E || extraIgnore`
- 实测：直接运行 `deno test -A e2e/rate-limit/rate_limit_lockout.test.ts` →
  `0 passed | 0 failed | 1 ignored`，**EXIT=0**
- 全仓 515 处跳过（`dev-docs/engineering/test-silent-skips.md` 记 511，本身已过期）
- `scripts/silent-skip-report.ts` **只写文件、从不 `exit 1`**，
  CI 步骤名即"静默跳过扫描（报告）"（`ci.yml:453-454`）

即：模块没配好环境时，CI 会**全绿地告诉你一切正常**。这在真实故障中比没有测试更糟，
因为它同时消除了"测试失败"与"根本没跑"两种信号。

**建议**：把跳过数、失败数、实际执行数纳入一个**基线文件**，
CI 中"跳过数增长"或"执行数低于基线"即失败（`check-test-discovery.ts` 已有正确范例——
它真的会 `exit 1`）。

### 5.2【高】生产 Compose 缺资源限制与日志轮转

三个 compose 文件中 `mem_limit|cpus|deploy:|resources:|ulimits` **零命中**；
`x-default-logging`（`docker-compose.prod.yml:51-55`）只被 `migrate`（`:61`）与
`core`（`:81`）引用，`postgres`/`redis`/`minio`/`nginx`/`ui`/`judge`/`llm-gateway`
全部使用无上限的 `json-file`。此外 judge 无 healthcheck。

**后果**：单机部署下最常见、最致命的两类故障——OOM 杀掉 postgres、
日志打满磁盘导致全站写入失败——都没有防线。

**建议**：给全部服务补 `mem_limit` + `logging: *default-logging`（把 anchor 提到每个服务）；
judge 补 healthcheck；为 `judge-cache`/`pgdata` 加磁盘水位告警。

### 5.3【中】监控栈不在部署产物中

`setup.sh` / `scripts/deploy/*.sh` / `noj-cli` 对 `prometheus|alertmanager`
搜索零命中；仅 README 有手工 `docker run` 指引。
即**一键安装产出的系统没有任何监控**——而 `deploy/monitoring/` 下的告警规则与
runbook 又都齐全（rule 带 runbook 注解 + `NojSloRulesMissing` 看门狗，质量很高）。

另：`prometheus.yml:26-29` 抓 `llm-gateway:8001/metrics`，
但 core 侧读取的键是 `RUNTIME_LLM_GATEWAY_URL`（注册表 bootstrap 键），
而 compose 只设了 `NOJ_LLM_GATEWAY_URL`（`docker-compose.prod.yml:28`），
`.env.prod.example:164-165` 两者都注释掉——**两个键名不一致**，需确认实际生效路径。

**建议**：把 monitoring（prometheus + alertmanager + node_exporter）做成
compose 的可选 profile（`--profile monitoring`），让一键安装即可获得可观测性；
统一 gateway URL 的键名并加 `check:env` 校验。

### 5.4【中】若干运维测试未接入 CI

`scripts/deploy/` 下 8 个测试脚本（约 130KB，含 `test-deploy.sh` 28KB、
`test-restore-drill.sh` 14KB）中，**仅 `test-monitoring.sh` 在 CI 运行**；
`scripts/staging/acceptance.sh` 同样零引用。

**建议**：把 `test-deploy.sh`/`test-backup.sh`/`test-restore-drill.sh` 纳入
`scripts/check-ci.ts`（它们本身是纯 shell 静态检查或可控的演练脚本）。

### 5.5【中】文档与实现脱节（会误导后续评审与 AI 助手）

本次评审的初始假设即来自过期文档，故单列：

| 文档 | 声称 | 实际 |
|---|---|---|
| `architecture-review-2026-09-01.md:107-114` §4.2 | 无前端单元测试 | 30 个测试文件/1737 行，vitest 已入 CI（`ci.yml:1886,1928`） |
| 同上 | composable 命名 camelCase/kebab-case 混用 | 31 个文件 **100% camelCase**；`use-submissions.ts` 不存在 |
| `noj-ui/AGENTS.md:403,407` | 同上两条 | 同上（同源错误） |
| `AGENTS.md:187` | 允许直接在 main 上开发提交推送 | 与 `noj-core/CLAUDE.md:631`、`dev-docs/engineering/development.md:70`「禁止直接推送 main」**直接矛盾** |
| `ROADMAP.md:111-116` | 监控告警/结构化日志/CI-CD/备份策略均未完成 | 均已实现 |
| `noj-core/CLAUDE.md` | 38 张表 | 实际 54 张 |
| `noj-core/src/domains/submission/types/index.ts:19` | 对齐 `noj-core/src/types/index.ts` | 该路径已不存在（`types.rs:27,73,117` 同样失效） |

**一段值得肯定的对照**：`tasks/silent-skip-report`、`check-domains`、`check-metrics`
等工具能存在，说明团队已经有"把口头约定变成可执行检查"的强烈意识。
**建议把同一手段用于文档**：`gen-route-catalog` 已经是生成式的正确范例，
把 route/metric/event catalog 全部改为生成产物，从根上消灭这一类漂移。

**特别的**：`architecture-review-2026-09-01.md` §4.2 的过期结论已被本次评审推翻，
建议在该文档顶部加一个"修订说明"指向本文，避免继续被当作事实来源。

---

## 6. 做得好的地方（建议保持并推广）

这些不是客套——它们构成了本项目的真实技术壁垒：

1. **评测沙箱的纵深防御**（`noj-judge/src/sandbox/host_config.rs:24-46`）：
   `cap_drop ALL` + `no-new-privileges` + `network_mode`（默认 none）+ `ipc_mode none`
   + `pids_limit 256` + `readonly_rootfs` + `privileged: false` +
   `memory_swap == memory`（禁 swap）+ CPU clamp。
   `memory_limit_mb == 0` 被规范化为 512 而非"不限制"（`dual/container.rs:191-195`）——
   这正是 Docker 的经典陷阱，处理得很专业。

2. **分布式每用户互斥的实现质量**（`noj-judge/src/user_claim.rs`）：
   claim 时间戳取自 **Redis 服务端 `TIME`** 而非调用方墙上时钟——
   该模块的注释准确指出了"多机时钟漂移会让互斥静默失效"这一真实失效模式，
   并把它从根上消除；"清理过期 + 判定 + 占用"在单条 Lua 内原子完成；
   `main.rs:200-223` 还把"claim TTL 必须大于评测上限"从注释提升为**启动期拒绝**。

3. **ZIP 防护按实际字节而非声明大小**（`sandbox/container.rs:84-99`：
   `take(max+1)` 后校验真实长度），拒绝路径穿越（`:59-64`）并有回归单测
   （`:357-376`）。上一版评审担心的"仅信任声明大小"未发生。

4. **结果投递的保守语义**（`noj-judge/src/mq.rs:202-204`）：
   只有真正 `LPUSH` 成功才 ACK；失败写 fallback 文件并**故意不 ACK**，
   留给 sweeper 重投。注释明确解释了取舍理由（宁可重投，也不接受
   "结果只落盘但任务已确认"导致永久卡 judging）。

5. **事务性 Outbox 已真实落地**（`submissions-result.ts:169-196`）：
   `sse_events` 与业务写在同一事务内插入，提交后再发布 Redis；
   配合 `event-bus.ts:93-102` 的 `publishSseEventAfterTx` 与
   `server-helpers.ts:78-95` 的 `afterSeq` 重放。
   上一版评审 §3.4 的建议已被采纳并实现得比建议更完整。

6. **LLM 数据所有权已彻底分离**：`llm_*` 表定义与迁移都已迁至
   `noj-llm-gateway/drizzle/`，core 侧**零直接读写**
   （`rg "llm_providers|llm_usage|llm_quotas" noj-core/src` 无命中），
   管理面通过 `/internal/*` HTTP 访问。上一版评审 §3.2 完整闭环。
   且网关的额度控制是**原子 reserve-then-settle**（`limits.ts:214` 与 `:260` 两段 Lua），
   按 submission/problem/user/global 四层计费，BYOK 走
   **allowlist + 私网地址拒绝**（`providers.ts:44-72`），token 为 AEAD 加密且带
   调用/Token 上限。

7. **域边界是真实被强制的**：`scripts/check-domains.ts` 不只是检查目录，
   还区分 source domain（`INDEX_IMPORT_RESTRICTED`/`NO_CROSS_DOMAIN_DOMAINS`），
   实测通过。`dev-docs/engineering/domain-boundaries.md` 与代码一致。

8. **前端工程化已补齐**：业务代码 `$fetch` 直调清零
   （`rg '\$fetch' pages/ components/` 无命中）；401 僵尸登录态已修
   （`useApi.ts:98-111` 同时清 `auth:user`、`noj:session` 并登出）；
   logout 先撤销 jti 再清 Cookie（`logout.post.ts:20-38`）；
   `nuxt.config.ts:77-87` 明确解释**为何不启 SWR**（避免按用户鉴权的接口
   把 A 用户数据缓存给 B 用户）——这个判断很成熟。

9. **代理层注释记录事故根因**：`[...slug].ts:319-334` 完整记录了
   "proxyRequest 返回值不是 Response，包一层会把上游 401/404 重置为 200，
   且只在构建产物暴露、dev 被 Node 兼容层掩盖"的排查过程。
   这类注释的长期价值极高。

10. **治理工具链成体系**：20 条仓库级校验（`check-ci.ts`）、
    92 份 Agent Note 且格式受 CI 校验、供应链钉死
    （digest + Cosign + SBOM + provenance）、备份/恢复有真实演练脚本
    （`restore-drill.sh` 起独立 compose 做 API 验收）。
    配置注册表 112 条单一事实源 + `check-config-usage.ts` 双向校验。

---

## 7. 对本次评审的自我更正（方法论透明）

为保证结论可信，记录两处经独立复核后**推翻**的中间结论：

1. **"答疑面板订阅了错误的 SSE 频道，实时更新失效"——不成立。**
   复核完整链路：`ClarificationsPanel.vue:78` 订阅
   `/api/v1/community/notifications/events`；该端点订阅 `Channels.user(userId)`
   （`community/routes/sse.ts:33`）；而答疑回复确实调用 `createNotification`
   （`contest-clarifications.ts:273`），后者发布 `Channels.user(recipientId)`
   （`notifications.ts:57`）。**链路是通的**。
   真实的局限只是：只有提问者本人实时收到（其他旁观者依赖 30s 轮询兜底），
   这是合理的设计取舍，不是缺陷。

2. **"judge 信号量 permit 泄漏导致僵尸占槽"——不成立**（由提出者自行复核后撤回）：
   拉取失败分支的 `continue` 作用于外层 loop，permit 正常 drop；
   shutdown 分支显式 `drop(permit)`；正常分支把 permit 移入 spawn 的任务。
   "先取槽位再拉任务"的顺序是正确的，其注释也是准确的。

另有一处**机制修正**：`JUDGE_MAX_EVALUATOR_TIME_MS=0` 不会让 deadline 变成 0ms
（`dual/mod.rs:127` 是 `if max > 0 { clamp }`，为 0 时**跳过** clamp，
题目自身的 `time_limit_ms` 保留）。真实风险是"judge 侧完全放弃硬上限"，
配合默认 `JUDGE_MAX_CONCURRENT_JUDGES=2`，两个长时限题目即可让 worker 停止服务。

**这三条记录在此，是为了说明本次评审的每条结论都经过了对抗性验证。**

---

## 8. 待确认的开放问题（需要你决策）

1. **是否存在"已应用 0079、未应用 0080、且有数据"的实例？**
   若有，则 §2.1 是**发布阻断级**问题，应优先于本文其他所有条目处理。
   这是唯一需要生产库访问权限才能定论的一条。
2. **`check-ci.ts` 其余 19 条门禁是否也存在同类"路径失效即静默通过"？**
   本次只逐一验证了 capability-seam 一条。建议做一轮针对性审计——
   这类缺陷的共性是"硬编码路径 + 精确匹配 + 无存在性自检"。
3. **noj-ui / noj-judge 是否计划多副本？**
   决定 §2.6 的处理优先级。若长期单副本，建议至少在文档中明确写下该约束。
4. **SSE 游标契约统一为 `Last-Event-ID` 还是 `afterSeq`？**
   现状：**实时事件不带 `id:` 字段**（`contest/routes/sse.ts:112` 等
   `writeSSE({ event, data })`），只有**重放**事件带 `id:`（`server-helpers.ts:86`）。
   因此浏览器自动重连时无法携带 `Last-Event-ID`，实际全靠前端显式累加
   `afterSeq`（`useEventSource.ts:154`）。服务端两者都读
   （`server-helpers.ts:18`）但只有一条真正生效。
   建议统一为 `id:` + `Last-Event-ID`（浏览器原生语义，重连更可靠），
   需前后端共同变更。
5. **`NOJ_LLM_GATEWAY_URL` 与 `RUNTIME_LLM_GATEWAY_URL` 哪个是权威键？**
   两者在 compose 与文档中不一致（§5.3）。
6. **`dev-docs/` 下过期结论的治理流程**：
   `architecture-review-2026-09-01.md` §4.2 已被代码推翻。
   是否接受"评审文档也标注有效期/修订指针"的约定？
7. **是否接受 `dual/mod.rs` 的拆分**（§3.2）？
   它是本次评审中耦合度最高、测试最难覆盖的文件。

---

## 9. 建议演进路线

| 阶段 | 重点 | 对应条目 |
|---|---|---|
| **立即（发布阻断）** | 修迁移 0080；修 `append_capped` panic；修 capability-seam 假绿灯 | §2.1 §2.2 §2.3 |
| **短期 1 个迭代** | 占位密钥校验；消费队列 sweeper 泛化；OAuth `redirect: 'manual'`；compose 资源限制与日志轮转；静默跳过基线门禁 | §2.4 §2.5 §4.1 §5.2 §5.1 |
| **中期** | 升级路径 CI 门禁；JudgeTask 契约收敛+快照测试；文档生成化（route/metric catalog、schema-ddl）；设置失效广播 | §2.1 §3.1 §3.3/3.4/3.5 §2.6 |
| **长期** | 多副本前置（advisory lock、清除进程内状态）；镜像 digest 白名单；`dual/mod.rs` 拆分；监控进部署产物 | §4.5 §2.6 §4.4 §3.2 §5.3 |

---

## 10. 一句话总结

Neuro OJ 的**技术决策质量高于其工程质量**：沙箱加固、分布式互斥、事务性 Outbox、
LLM 数据分离这些"难做对的事"都做对了，且注释记录了大量真实事故的根因；
当前最大的风险不在架构选型，而在**"验证闭环"** ——
迁移只测空库、E2E 静默跳过、门禁路径失效后仍报绿、
多副本假设从未被验证。**建议把下一个迭代的重心放在"让门禁说真话"上**，
其收益高于新增任何功能。
