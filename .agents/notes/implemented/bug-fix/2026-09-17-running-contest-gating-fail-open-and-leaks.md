# Agent Note: 赛期门控的四类失效修复（评审 C1/C2/C3 + 六条未门控读路径）

Status: implemented

## Problem

2026-09-14 的代码评审判定「出题人与选手体验增强」变更链（`b318aa1c..7058e7f0`，13 提交）
**不可合并**：该变更集的核心是一个安全控制（赛期隐藏题解与通过率），而该控制不成立。
本轮修复其全部 Critical/High 结论。四条独立的根因如下。

### 1. 时间按**文本**比较，对合法非规范形态 fail-open（C1）

`contests.start_time` / `end_time` 是 ISO 8601 **文本**列。读侧用
`to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` 生成同形状
字符串做**字典序**比较，并注释断言"与 `new Date().toISOString()` 同格式，故字典序
等价于时间先后"。该前提**没有任何机制保证**：

```text
start = 2026-09-14T10:19:18.087+08:00   end = 2026-09-14T11:20:18.087+08:00
nowZ  = 2026-09-14T02:36:16.970Z
字典序谓词 running = false   ← 错（'+' 是 0x2B，低于 'Z' 的 0x5A，end_time > nowZ 恒假）
按时刻比较 running = true    ← 对
```

后果不是显示错误：`computeContestStatus`（走 `Date.parse`）说"进行中"，而 SQL 谓词
说"未进行"，于是**列表 / 类型计数 / 收藏 / 动态流 / 搜索 / 发布门槛全部放行**。
同一写入使题解门控与通过率抑制同时静默失效。该个错误假设被复制在 **4 处**
（`community-post-common.ts`、`community-feed.ts`、`permission-filter.ts`、
`problem-exposure.ts`）。

### 2. 通过率抑制可被**算术还原**（C2）

抑制只把 `acceptance_rate` 置 null，却照常返回 `accepted_count` 与 `submit_count`——
而被扣留的通过率恰为 `accepted_count / submit_count`，两个整数即可还原该先验。

### 3. 公开统计缺少可见性校验（C3）

`/:id/stats/public` 调用 `resolveProblem(id)` 时**未传 viewer**，因此完全不触发访问
校验：私有题统计匿名可读，且 200/404 的差异使其成为**存在性预言机**（可按
`display_id` 枚举私有题）。

### 4. 门控只覆盖五条读路径，另有六条旁路

用户主页题解列表（匿名可读标题与内部 id）、主页 `solution_count`、举报创建返回完整
正文、举报详情返回正文、搜索未覆盖 `community_comment`（评论条目携带 `post_title`）、
点赞/收藏写入后才校验。其中「匿名主页拿 post id → 举报接口拿全文」可**链式利用**。

### 为什么这四条能同时存活

**测试从未创建过"进行中的竞赛"。** catalog 的统计测试里 `contest` 一词出现 0 次，
`running_contest` 这一生产字符串在任何测试中 0 次，抑制分支从未被执行。更隐蔽的是：
既有夹具**全部**用 `new Date().toISOString()` 生成时间，即只产生**规范形态**——
而 C1 只在非规范形态下显现。用规范形态做夹具，会让类级错误假设永远测不出来。

## Decision

### C1：三道防线 + 单一来源

1. **写侧规范化**（最高杠杆的单点修复）：`normalizeTimes()` /
   `normalizeContestTime()` 把所有入库时间统一为 `toISOString()` 形态；`freeze_start_time`
   一并规范化（此前原样落库，会违反新约束）。
2. **读侧按时刻比较**：新增 `contest-window.ts` 作为**唯一**判定来源，导出
   `runningWindowCondition` / `runningContestExistsForProblem` /
   `runningContestProblemIds`，用 `::timestamptz` 比较。4 处调用点全部改为复用。
3. **DB 形态约束**：迁移 `0083` 先规范化存量行，再以 `NOT VALID` 添加形态 CHECK
   （`schema-ddl.ts` 同步镜像，供 PGlite 全新建表）。

`runningWindowCondition` 用 `CASE` 而非 `AND` **并列**正则守卫：`'x'::timestamptz`
对非法文本会**抛错**，而 SQL 的 `AND`/`OR` **不保证短路求值**，一条脏数据就能让
社区列表/搜索/详情全部 500。`CASE` 的求值顺序**有保证**。形态非法时判为"进行中"
（fail-closed）：无法证明竞赛已结束，故隐藏内容而非泄露内容。

`NOT VALID` 是必需的：存量库中任何非规范行都会让裸 `ADD CONSTRAINT` 失败，而迁移失败
会让整批迁移回滚、core 因 `depends_on` 永不启动（全站不可用）。

### C2：三项一并抑制

`accepted_count` / `submit_count` / `acceptance_rate` 赛期**同时**置 null（类型改为
`number | null`），调用方无法从任何组合反推通过率。`attempt_count` 不含通过信息，
保持可见。UI 的 `ProblemStatsDetail` 不再 `extends PublicProblemStats`——owner 视图
不受抑制，可空类型只会制造无谓的空值判断。

### C3：与兄弟 handler 同口径

`/:id/stats/public` 改为传 viewer 并调 `resolveProblemAccess`，拒绝时抛
`NotFoundError`（与 `/:id` 的"无权限一律 404，防存在性探测"一致）。

### 六条读路径：收敛到共享谓词，而非各写一份

用户主页（列表 + 计数）、举报创建与详情、搜索注释条目全部接入同一赛期判定。
搜索的注释门控**按 `metadata->>'post_id'` 实时 join** `community_posts`，而非依赖
索引新增字段——后者对存量索引行不生效，修复会在重建索引前形同虚设。
搜索谓词同时补 `problem_id IS NOT NULL` 守卫（`NULL IN (...)` 为 NULL，会让
`NOT (... AND NULL)` 整体为 NULL 而永久排除该行）。

点赞/收藏改为**写入前**校验可交互性（复用 `getPost`），既阻止写入指向赛期题解的
互动行，也消除"成功 vs 外键错"的**状态码差异**所构成的存在性预言机。

### 同步修复的次级缺陷

- `setPostOfficial` 此前**全仓零 HTTP 路由**（能力半交付：徽章能显示但无人能标记，
  审核员也无法标记他人题解）→ 补 `PATCH /posts/:postId/official`。
- `createPost` 只校验 `isProblemOwner` 而不限定类型：discussion/moment 不规范化
  `problem_id`，客户端夹带任意公开题 id 即可获得官方标记，并因 `listPosts`
  无条件按 `is_official` 置顶而**置顶社区列表** → 增加 `type === "solution"` 限定。
- 游标分页只排除 `is_pinned` 而排序键是 `(is_official, is_pinned, created_at)`，
  导致官方题解在**每一页**重复 → 补齐 `is_official` 排除。**同时发现更深的第二个
  缺陷**（由本轮新增的回归测试暴露）：`orderBy` 缺 `id` 决胜键，而游标只带
  `created_at`，于是同一时刻的多条会在页边界被**静默丢失**（SQL 不保证同键行的
  返回顺序）。`listFeed` 早已用 `created_at|id` 复合游标解决，`listPosts` 未跟上 →
  改为同样的复合游标 + `desc(id)` 决胜键，并保留对纯 `created_at` 旧游标的解析
  兼容（第三方/缓存游标不会失效）。
- `highlight=` 写而不读（W1 验收标准「点击行跳转到含 code 的提交详情」按钮存在、
  能力不存在）→ 读取该参数并交给既有 `submission_id` 筛选。
- 迁移门禁只比对**表名集合**，删列/删索引不被发现 → 升级为列/索引/约束级结构摘要，
  并把 DROP 白名单从"全局永久"改为**按迁移编号区间**作用域。
- PGlite 模板缓存两处：hash 命中路径提前 return 导致 sidecar 不重建（每个测试文件
  静默退化为 DDL 慢路径）；同步指纹只哈希 `schema-ddl.ts` 而异步 hash 覆盖 4 个输入，
  仅改种子文件时会**静默复用旧种子** → 统一输入清单、命中路径也维护 sidecar。

### 测试补强

新增 `src/shared/testing/contest-fixtures.ts`，核心是
`nonCanonicalOffsetTimes()`——产出与规范形态**同一时刻**的 `+08:00`、秒级精度写法。
这正是既有夹具集体缺失的形态，也是 C1 得以存活的根因。

`withLegacyDirtyRowsAllowed()` 临时移除形态约束以构造"迁移前存量脏行"（NOT VALID 的
真实语义：约束只作用于新写入）。

## Alternatives considered

- **只修写侧，不加读侧与 DB 约束**：写侧只能防未来写入，存量脏行仍会 fail-open，
  且任何绕过服务层的写入（管理脚本、人工改库）都能重新引入。三道防线成本很低
  （一个策略模块 + 一条迁移），只做一道不划算。
- **读侧改用 `Date.parse` 在应用层判定**：需先查出候选题目再过滤，会退化成
  "先查 id 再拼 IN 列表"——该方案必须设上限，上限一旦被超出就会**静默漏掉**应门控的
  题目。对安全门控这是不可接受的失效模式，故坚持 SQL 内相关子查询。
- **形态非法时判为"未进行"（fail-open）**：与"无法证明已结束"矛盾，且失效方向是
  **泄露**。安全门控的失效方向必须是隐藏。
- **给 `search_entries` 加 `problem_id` 字段并依赖它**：对存量索引行不生效，修复会在
  重建索引前形同虚设。实时 join 无此问题（代价是一次索引内的 join）。
- **C2 只抑制 `accepted_count`，保留 `submit_count`**：仍可结合 `attempt_count` 与
  榜单信息做出较强推断，且无产品价值（提交数在赛期本身不构成难度先验）。一并抑制
  的语义更清晰：赛期不提供该题的任何通过统计。
- **用 `\!` 转义点号写形态正则**：drizzle-kit 在快照 JSON 序列化时**丢掉反斜杠**，
  `\.` 静默退化为 `.`（匹配任意字符，约束被悄悄放宽——实测确认）。改用字符类
  `[.]`，无需转义，可安全往返。
- **把约束直接写进迁移而不改 `schema-ddl.ts`**：PGlite 走 `schema-ddl.ts` 全新建表，
  不同步会让测试环境缺少该约束，"第三道防线"在测试中不存在。

## Consequences

- 赛期门控现在是**形态无关**的：`+08:00`、`-05:00`、`+05:30`、秒级精度均正确判定。
- 存量库升级安全：迁移先回填再 `NOT VALID` 加约束，任何无法解析的脏行不会阻塞上线
  （但新写入一律受约束）。已在真实 PostgreSQL 16 上以 4 类脏行形态实测验证：
  `+08:00`、秒级精度、空格分隔三种存量行全部被回填为规范形态，且 fail-open 的
  `+08:00` 行与规范行收敛到**同一时刻**。
- 每一条修复都有**能抓住该缺陷**的回归测试（逐条注入缺陷变体实测失败后恢复）：
  C1（2 个用例失败）、C2、C3（2 个用例失败）、High#1/#2、High#5、官方标记夹带、
  游标重复；迁移门禁的列级检查亦用评审给出的原始实验复现（旧实现 exit 0 → 新实现 exit 1）。
- **本轮新增测试还独立发现了第二个游标缺陷**（见上「同步修复的次级缺陷」）：
  `orderBy` 缺 `id` 决胜键导致同刻条目跨页丢失。该缺陷不在原评审报告内。
- **修正一处此前的误判（重要）**：本轮初次排查时曾把
  `tests/db/migration_0080_backfill_test.ts` 的存量回填用例与
  `src/domains/contest/tests/routes/sse.test.ts` 的"不存在的竞赛返回 404"记为
  "先于本轮存在的产品缺陷"。经进一步定位，**两者都不是产品缺陷**，而是
  **PGlite 模板缓存冷启动**导致的测试可复现性缺口：
  `createPGliteInstanceFromTemplate()` 同步加载模板且不做 hash 校验，校验只在
  `ensurePGliteTemplateCached()` 里；而 `test-shared.sh` 此前**没有**在 PGlite 模式下
  重建模板（`test-domain.sh` 有）。冷缓存时模板缺失 → `getDb()` 退化为
  `new PGlite()` 创建**零张表**的空库；这两个用例都不调用 `resetDbForTest()`
  （只有它才触发 DDL 引导），于是以"表不存在"失败。热缓存下通过——所以该缺陷只在
  "冷启动 + 本地 PGlite"这一组合显现（CI 用真实 PG，走不到该路径）。
  已在 `scripts/test-shared.sh` 补齐与 `test-domain.sh` 一致的模板准备步骤（并补
  `JWT_SECRET` 本地兜底），从**真正冷缓存**验证：修复前 1 failed → 修复后
  238 passed / 0 failed。
  教训：**不使用文档规定的测试命令（`deno task test:domain` /
  `bash scripts/test-shared.sh`）会得到误导性的"产品缺陷"结论**——它们封装了
  模板准备、JWT_SECRET 与 preload 等必要环境。
- 迁移 `0083` 的形态约束对**历史**脏行不生效（NOT VALID 语义）。若要彻底收敛，
  需在清理存量后执行 `VALIDATE CONSTRAINT`；当前读侧已 fail-closed，故不阻塞。
- 评论门控引入一次额外 join，仅作用于搜索路径且已有 `entity_type` 过滤在前。
- `listPosts` 的游标由纯 `created_at` 改为 `created_at|id`：新客户端无需改动
  （游标是不透明字符串），旧游标仍被 `parsePostCursor` 兼容解析（退化为时间比较，
  即修复前行为，不会报错）。
- `withLegacyDirtyRowsAllowed()` 依赖 preload 的事务回滚来复原被临时移除的约束；
  若未来有测试禁用事务隔离（`_testTransactionDisabled`），该辅助函数会**永久移除
  约束**并污染同进程后续用例。已在 doc-comment 中写明该前提。
- 受影响的读路径现在共享 `contest-window.ts` 的单一判定。**新增任何赛期判定都必须
  复用它**，否则会再次出现本轮这种"四处副本各自漂移"的失效模式。
