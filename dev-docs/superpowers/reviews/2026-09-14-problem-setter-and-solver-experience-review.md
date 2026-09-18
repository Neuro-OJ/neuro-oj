# 代码评审：出题人与选手体验增强（W1 + W2 + W3）

- **评审范围**：`b318aa1c3..7058e7f04`（13 个提交，55 文件，+14386/−20）
- **评审方式**：3 个并行评审子代理（W3 门控 / 迁移引擎 / W1+W2），各自只拿到「需求 + diff 范围」，不共享本会话历史；由协调者独立复现全部 Critical 结论
- **结论**：**不可合并（NO）** —— 核心安全控制存在可复现绕过

> 本报告中的每条 Critical/High 结论均由协调者在真实 PostgreSQL 16 或真实代码路径上**独立复现**，
> 而非仅采信子代理陈述。子代理编号仅用于区分来源。

---

## 一、总体评价

工程手艺是好的，但**本变更集的核心目的是一个安全控制，而该控制不成立**。

值得保留的部分：

- 门控放在**服务层/SQL 层**而非路由层（`listPosts`/`getPost`/`countPostsByType`/`listBookmarks`/搜索谓词），新调用方无法遗漏
- **作者本人也被门控**，并注释说明自视图即侧信道；已有测试覆盖
- 主读路径返回 **404 而非 403**，与「真不存在」不可区分，不给出存在性确认
- 审核员豁免由 JWT + RBAC **服务端计算**（`checkPermission`），无请求参数可伪造
- 迁移合规：`ADD COLUMN ... DEFAULT false NOT NULL`，`schema-ddl.ts` 同步镜像，四个门禁全过
- 测试跑**真实数据库**而非 mock（community 50、search 25、contest 54 全绿）
- 无新增进程内可变状态用于门控判定（纯实时 SQL 窗口比较，竞赛开始/结束无需状态翻转）
- 隐藏用例匿名化对**对抗性命名的攻击真实有效**（真实 id 名叫 `hidden-1` 也不会串桶）

### 协调者对两个「评审自身结论」的更正

1. **我此前的格式扫描不够充分，审查者是對的。** 我先前用「起始时间在数天前」的窗口做扫描，日期高位数字主导了字典序比较，掩盖了缺陷。审查者用**同一 UTC 日历日 + `+08:00`** 的真实形态复现，实测确为 fail-open（见 C2）。
2. **提交 `91354046d` 并未改动 `_journal.json` 与 `0082_snapshot.json`**，二者属于其子提交 `b17290abb`。我对 journal/0082 的校验在 HEAD 上仍然成立，但任务书中的归属描述有误。

---

## 二、Critical（必须修复）

### C1 — 赛期门控对「非 `toISOString()` 形态的合法 ISO-8601 时间」**fail-open**

**位置**：`noj-core/src/domains/community/services/community/community-post-common.ts:95-107`（`notGatedSolution`），同一比较**复制**于：

- `community/services/community/community-feed.ts:158-159`
- `search/services/permission-filter.ts:55-56`
- `contest/services/problem-exposure.ts:31-40`（Drizzle `lte`/`gt` + `new Date().toISOString()`）

**问题**：`contests.start_time`/`end_time` 是 **TEXT** 列（`schema/contest.ts:28-29`，NOT NULL），
写侧 `validateTimes()`（`contest/services/contests.ts:107-121`）只校验 `Date.parse` 非 NaN，
**既不规范化也不做形态约束**，字符串**原样落库**。SQL 却按字典序与 UTC `Z` 字面量比较：

```sql
c.start_time <= to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
c.end_time   >  to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
```

`+08:00` 的 `'0'` 排序低于 `'Z'`，故 `end_time > nowZ` 对整个竞赛窗口恒为 false。

**协调者独立复现**（真实 PostgreSQL 16，同一 UTC 日历日的进行中竞赛）：

```
start = 2026-09-14T10:19:18.087+08:00   end = 2026-09-14T11:20:18.087+08:00
now_iso = 2026-09-14T02:36:16.970Z

SQL 谓词判定 running = f        ← fail-open
::timestamptz 判定 running = t  ← 真值
```

**后果**：`computeContestStatus`（`Date.parse`）与详情页说「进行中」，而 SQL 谓词说「未进行」，
于是**列表 / 类型计数 / 收藏 / 动态流 / 搜索 / 发布门槛全部放行**——选手在列表里直接拿到完整题解。
同一写入使 W2 的通过率抑制（C2）与 W3 的题解门控同时失效。

另有次生问题：秒级精度字符串（无 `.MS`）时 `'Z' > '.'`，起始那一秒谓词为 false，产生约 1 秒窗口。

**修复**：按**解析后时刻**比较，而非按文本比较：

```sql
c.start_time::timestamptz <= now() AND c.end_time::timestamptz > now()
```

并在写侧规范化（`new Date(input.start_time).toISOString()`）＋ 加 DB `CHECK` 约束规范形态；
三个副本收敛为**单一共享 SQL 片段**（从 contest 域门面导出），否则必然漂移。

---

### C2 — 赛期通过率抑制可被**算术还原**

**位置**：`noj-core/src/domains/catalog/services/problems/problems-stats.ts:244-252`

抑制只把 `acceptance_rate` 置 null，却**照常返回 `accepted_count` 与 `submit_count`**：

```json
{"attempt_count":1,"submit_count":3,"accepted_count":1,
 "acceptance_rate":null,"suppressed_reason":"running_contest"}
```

被扣留的通过率恰为 `accepted_count / submit_count` = 1/3。

**为何重要**：Agent Note 自述抑制理由是「通过率是难度先验，赛期公开等于泄题」。
以两个整数形式返回，等价于完整泄露该先验。`/:id/stats` 已正确锁定 owner/admin，
故这是唯一公开面，无二阶修复路径。

**修复**：赛期同时抑制 `accepted_count`（并考虑 `submit_count`）；类型改为 `number | null`。
UI 侧改动很小——`describeAcceptance` 已对 `suppressed_reason` 短路。

---

### C3 — `/:id/stats/public` **缺少可见性校验**，私有题统计匿名可读且构成存在性预言机

**位置**：`noj-core/src/domains/catalog/routes/problems.ts:474-477`

```ts
const problem = await resolveProblem(c.req.param("id") as string);  // 未传 viewer
```

`resolveProblem` 未传 `{ userId, isAdmin }`，**不触发任何访问校验**。同路由的兄弟 handler
（`problems.ts:196-210`）明确注释「无权限一律 404，防存在性探测」并调用 `resolveProblemAccess`。

**实测**：

```
GET /problems/:id              -> 404   （正确）
GET /problems/:id/stats/public -> 200   {"...","acceptance_rate":0,"suppressed_reason":null}
```

且可按 `display_id` 枚举：存在的私有题 `U999100` → 200，不存在 → 404。

**修复**：与兄弟 handler 一致——传 viewer、调 `resolveProblemAccess`、拒绝时抛 `NotFoundError`。

---

## 三、High / Important

### 未门控的读路径（审查者已复现，协调者已逐条核验代码）

| # | 路径 | 位置 | 结论 |
|---|---|---|---|
| 1 | 用户主页题解列表（**匿名**） | `identity/services/users/users-profile-queries.ts:137-153` | 泄露赛期题解**标题**与内部 id |
| 2 | 用户主页 `solution_count` | 同文件 `:127-131` | 泄露数量 |
| 3 | 举报创建**返回完整正文** | `community-moderation.ts:79-91,154,176` ← `routes/community.ts:594-613` | `content_snapshot` = 完整题解正文 |
| 4 | 举报详情返回正文 | `community-moderation.ts:475-481` ← `routes/community.ts:619-625` | 举报人可读全文 |
| 5 | 搜索未覆盖 `community_comment` | `permission-filter.ts:47-58` | 评论条目携带 `post_title`，泄题解标题 |
| 6 | 点赞/收藏未门控 | `community-interactions.ts:59-91` | 404 vs 500 存在性预言机 + 可写入隐藏互动行 |

**协调者核验要点**：

- #1/#2 确认：`GET /api/v1/users/:id/profile` **无 auth 中间件**，文档标注「公开访问，无需认证」，
  `noj-core/AGENTS.md` API 表亦标为「公开」；UI 在 `noj-ui/pages/users/[id].vue:376` 直接渲染标题。
  **该路径既不在 spec 的 5 条清单内，也无任何测试**——属**规划阶段的盲区**（spec §6.2 只枚举 5 条路径）。
- #3/#4 确认：`createReport` 读 `content` 时无门控，`content_snapshot` 原样返回；
  `community:report` 在默认角色权限集内（`seed-rbac.ts:50`）。
  **#1 → #3 可链式利用**：匿名主页拿 post id → 举报接口拿全文。两段都无门控。
- #5 确认：`runningContestSolutionWhere` 只匹配 `entity_type='community_post'`，
  文件内唯一的 `community_comment` 出现在 `communityVisibilityWhere`（功能关闭分支），
  而评论条目确带 `post_title`（`index-writer.ts:291-297`）。
- #6 确认：`togglePostLike`/`toggleBookmark` 在写入后才调 `getPost`（且仅用于发通知），
  `toggleBookmark` 完全不调——故不能作为门控。

### 其他 Important

- **`setPostOfficial` 无任何 HTTP 路由**（`community-post-crud.ts:360-379` 仅有定义，全仓零调用）。
  现有题解无法被标记官方，**审核员也无法标记他人题解**——spec §6.1 要求的能力未交付，且无 UI 写入 `is_official`。
- **`createPost` 允许 discussion/moment 携带官方标记**（`community-post-crud.ts:189-190`）：
  客户端夹带的 `problem_id`（仅 `solution` 会被规范化）使 `isProblemOwner` 为真，
  而 `listPosts` **无条件** `desc(is_official)` 排序（`community-post-list.ts:100`），
  故这类帖子会置顶社区列表，绕过 `setPostOfficial` 的「仅题解可标记」规则。
- **游标分页重复**：`listPosts` 按 `is_official, is_pinned, created_at` 排序，但游标只排除 `is_pinned`
  （`:86`，注释显示已知此失效模式却未扩展到新排序键）→ 官方题解在**每一页**重复出现。
- **任意有 `contest:create` 的用户可长时间隐藏任意公开题的题解**：
  `contest:create` 在默认角色内（`seed-rbac.ts:41`），`assertContestProblemAddable`
  （`contests.ts:237-259`）允许非管理员加入**任意公开题**，`end_time` 无上界。
  门控只看「题目 ∈ 任意进行中竞赛」，不看创建者或观看者是否参赛 →
  可构造一年期邀请赛作拒绝服务/反竞争原语。**spec §6.6 的「有意取舍」只考虑了正当自重叠，未考虑对抗性包裹**——属规划层缺口。
- **`highlight=` 写而不读**：`admin/contests.vue:755` 跳转
  `/admin/submissions?highlight=<id>`，但全仓无任何代码读取该参数
  （`admin/submissions.vue` 连 `useRoute()` 都没调用）。spec §7 把「点击行跳转到含 code 的提交详情」
  列为 W1 验收标准——按钮存在，能力不存在。
- **`problem-exposure.ts` 的格式假设被当作保证写进注释**
  （`:14-15`「与 `new Date().toISOString()` 同格式，故字典序比较等价于时间先后比较」），
  但无任何机制保证。该注释正是 C1 的错误前提。

---

## 四、测试缺口（这些缺口正是 Critical 得以存活的原因）

- **W2/W3 全仓没有任何测试创建过「进行中的竞赛」**：catalog 两个测试文件中 `contest` 一词出现 **0 次**，
  两处断言都只覆盖 `suppressed_reason === null`。`running_contest` 这一生产字符串在任何测试中 **0 次**。
  抑制分支从未被执行。（协调者用临时 PGlite 测试实测该分支**功能正确**：
  `DURING → running_contest/null`，`AFTER → null/0`；缺口纯属覆盖缺失。）
- **迁移门禁只比对「表名集合」**：`check-migration-snapshot-chain.ts:35` 把快照降维成表名集合，
  所有规则都只作用于该集合。协调者实测：从 0081 快照**删掉一列**
  （`search_entries.deleted_by_user_ids`）→ 门禁输出「通过」exit 0，
  随后 `db:generate` 生成 `ALTER TABLE "search_entries" ADD COLUMN "deleted_by_user_ids" ...`
  ——**与它存在意义完全相同的部署致命 DDL**。删除一个索引同理。
  这也意味着**手工修快照在列级完全不受保护**。
- 门禁的「自检」测试并未测试自检：`_test.ts:71-78` 只断言
  `listSnapshots(空目录).length === 0`，**从不调用 `checkSnapshotChain()`**；
  删掉检查器内的 `files.length === 0` 守卫该测试仍会通过。
- 无任何测试断言「人为构造的丢表会被检出」（即缺少正向回归用例）。
- `searchGrouped` 无门控测试（它有自己的谓词副本，且正是 #5 泄露的路径）。
- 发布门槛（`can_create=false` + `blocked_reason`）无测试；spec §6.8 明确要求。
- 5 分钟缓存无 hit/miss/TTL 行为测试（6 处 `_resetProblemCacheForTest` 全是防御性重置）。
- `truncated: true`（2000 上限）无测试；spec §5.9 要求。

---

## 五、其他已核验结论

**验证达标**：

- 迁移 `0082` 只含 `ADD COLUMN is_official` + `CREATE INDEX`，无杂散 `CREATE TABLE`
- 快照链 `id`/`prevId` 在 0071→0082 连续无断裂；`_journal.json` 为纯追加（82→83，前缀完全保留）
- `0082_snapshot.json` 54 表、含 `search_entries` 与 `is_official`
- 快照修复**可证明为语义纯净**：对 0076–0081 剥离 `public.search_entries` 后与修复前 JSON 完全一致；
  修复块的 sha256 与 0075 完全相同（无字段漂移）
- **新门禁确实能抓住它要抓的 bug**：在修复前的树上运行新检查器 → exit 1，
  精确报出 `search_entries` 在 0075→0076 消失 + 代码/快照不一致（协调者实测，非推断）
- 修复提交 `91354046d` **先于**生成迁移的子提交 `b17290abb`，顺序正确——这正是 0082 得以正确的原因
- W1 契约（`SimilarSubmissionPair` 14 字段 / `SimilarSubmissionsMeta` 9 字段 / `data_policy`）
  与后端构造逐字段一致；W2 的 `PublicProblemStats`/`ProblemStatsDetail` 亦然
- 隐藏用例匿名化：真实 `case_id` 只作内部去重键，绝不进入返回值；对抗性命名测试有效
- 题目暴露判定（`problem-exposure.ts`）**无缓存无调度**，且被 6 个测试覆盖（含边界/自动解除/双竞赛）
- `statsCache` 已按 AGENTS.md §8.2 登记入「多副本约束」表

**非问题**（已排查干净）：

- 社区 SSE 需认证且只传 `{type, notification_id}`，无内容
- 无 sitemap/RSS/导出/dump 端点泄露题解
- `content-review` 详情仅经 `admin/routes/community.ts` 可达（审核员豁免，属有意）
- 通知行只存 `post_id` + 静态文案，无标题解析
- 动态流门控正确使用 `community_events.subject_id`（计划文档误写为 `target_id`，实现是对的）
- `searchFlat` 与 `searchGrouped` **均已**接入谓词（帖子部分门控有效）
- 搜索谓词缺 `problem_id IS NOT NULL` 守卫（NULL → `NOT NULL` → 行被**永久**排除），
  但 `solution` 类型强制要求 `problem_id`（`community-post-crud.ts:135-137`），故当前**潜伏不可达**

**关于「进程内可变状态」**：`computeSchemaFingerprintSync()` 是纯函数、sidecar 是磁盘文件，
模块内既有的 `_pgliteTemplateLoaded`/`_pgliteInstance` 属先前存在，故本次**不欠**多副本登记。

---

## 六、迁移引擎修复的额外发现

- **PGlite 模板缓存升级路径有个洞**：`connection.ts:171-176` 的提前 return 发生在
  **新 sidecar 写入（`:184-188`）之前**。协调者实测：删除 sidecar（保留 `.hash` + `.tgz`）后
  运行 `deno run -A scripts/prepare-pglite-template.ts` → 打印「模板就绪」但 sidecar **未重建**。
  后果**仅为性能**：`createPGliteInstanceFromTemplate()` 返回 null → 走慢速 DDL 路径，**正确性安全**；
  但每个既有缓存会静默失去快路径，直到 `schema-ddl.ts` 下次变更才自愈。
- **同步指纹覆盖面小于它守护的模板**：`computeSchemaFingerprintSync()` 只哈希 `schema-ddl.ts`，
  而异步哈希覆盖 `schema-ddl.ts` + `seed-rbac.ts` + `community-seed.ts` + `PGLITE_TEMPLATE_FORMAT`。
  两者可分歧：若仅 seed 文件变更，同步加载器认为指纹匹配 → **静默加载陈旧种子数据**。
- **`DROP TABLE` 白名单是全局且永久的**：一旦历史任一迁移含 `DROP TABLE foo`，
  `foo` 便可在**任何**后续快照中消失而不被察觉。当前无实际漏洞（仅 `categories`/`problems_categories`），属潜伏。
- **Agent Note 引用了不存在的历史文件名**：Note 第 11 行引用
  `0082_rare_master_chief.sql`，该文件仅存在于不可达的悬挂提交 `9e1d56514`；
  实际落地的是 `0082_orange_omega_red.sql`。Note 还描述了属于其子提交的产物。
- `deno lint scripts/check-migration-snapshot-chain_test.ts` → exit 1（`ban-unused-ignore`，
  未使用的 `no-explicit-any` 忽略）；根目录 `scripts/` 未被 CI lint 覆盖。
- `0076_snapshot.json` 的 `1 -` 是**行尾换行规范化**，非内容丢失（已逐字节验证）。

---

## 七、结论与建议

**Ready to merge? NO.**

**理由**：本变更集的核心是一个安全控制，而该控制不成立——
通过率在抑制生效时可被算术还原（C2）；非规范 ISO 偏移量静默禁用抑制**与**W3 的题解门控（C1）；
私有题统计匿名可读且存在性可枚举（C3）；此外还有 6 条未门控读路径，
其中「匿名主页标题 → 举报接口全文」可链式利用。
三者均经真实数据库复现，且之所以全部存活，是因为**两个工作流中没有任何一个测试创建过进行中的竞赛**。

**建议修复顺序**：

1. **C1 优先于 C2**（C2 是单端点有界泄露，一行可修；C1 是跨两个工作流、四个文件的类级错误假设，
   且被注释当作保证）。写侧规范化是最高杠杆的单点修复，一处修复同时覆盖两个工作流。
2. C3 与未门控读路径：**收敛为单一共享门控谓词**，并补「进行中竞赛」共享测试夹具
   （`seedRunningContest()`）——这是 C1 得以存活的根因。
3. `setPostOfficial` 路由要么补上，要么显式降级并从导出中删除（当前是死代码 + 半交付能力）。
4. 「对抗性包裹公开题」是**规划层缺口**（spec §6.6 未覆盖），需产品决策：
   限制为观看者已报名的竞赛 / 限制为管理员创建的公开赛 / 约束 `end_time` 上界。
5. 迁移门禁从「表名集合」升级为**结构摘要**（列 `(name,type,notNull,default,primaryKey)` +
   索引签名）。数据已具备这些字段，无需 schema 变更或新依赖。
   仅「最新快照在列级必须是前一快照的超集」这一条最小规则即可覆盖列删除与原始丢表两种情形。
6. PGlite sidecar 修复（提前 return 分支补写 sidecar）＋ 统一两个指纹的输入文件清单。

**流程建议**：给 `db:generate` 加一个 CI dry-run（或「generate 后 `git diff --exit-code`」），
这是唯一能对着**代码**（而非对着更多快照）校验快照保真度的检查，
本可当场抓住 0082，也是手工修快照这一技术唯一可被审计的护栏。
