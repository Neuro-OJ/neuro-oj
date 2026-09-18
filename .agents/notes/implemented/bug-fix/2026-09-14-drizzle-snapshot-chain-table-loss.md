# Agent Note: drizzle 快照链丢表导致迁移重发 CREATE TABLE（并修复 PGlite 模板静默过期）

Status: implemented

## Problem

在实现「题目官方题解」特性、为 `community_posts` 增加 `is_official` 列时，
`deno task db:generate` 生成的迁移**同时**包含了一条重复建表语句：

```sql
CREATE TABLE "search_entries" ( ... );   -- 0082_rare_master_chief.sql 第 1 条
ALTER TABLE "community_posts" ADD COLUMN "is_official" boolean DEFAULT false NOT NULL;
CREATE INDEX "idx_search_entries_entity" ... ;
```

`search_entries` 早在 `0074_rare_molecule_man.sql` 就已创建。
**该迁移在任何存量部署上必然失败**（`relation "search_entries" already exists`），
而 `drizzle` 的 migrator 把待执行迁移包在单个事务里、失败即整批回滚，
`core` 又因 `depends_on: migrate: service_completed_successfully` 永不启动
—— 即**全站不可用**。这与 2026-09-12 评审 §2.1（迁移 0080）属同一失效模式。

### 根因：快照链静默丢表

`drizzle/meta/*_snapshot.json` 是 drizzle-kit 生成增量迁移的**唯一基线**。
逐快照比对发现：

| 快照 | 表数 | 含 `public.search_entries` |
| --- | --- | --- |
| 0075 | 54 | ✅ |
| 0076（PR #473 起） | 53 | ❌ |
| 0077 – 0082 | 53 → 54 | ❌（直到本次修复） |

即 PR #473（管理员 UI 重做）**从快照链中丢掉了 `search_entries`**，
且此后 6 个快照一直缺失。因 `drizzle` 只与**最新**快照 diff，
下一次 `db:generate` 便把它当作新表重新建表。

### 为什么 CI 没有拦住

唯一执行文件迁移的测试是 `noj-core/tests/00_migrate_test.ts`，它跑在**空库**上：
`CREATE TABLE search_entries` 在空库上成功，因此全新安装通过、
只有存量升级会炸 —— 与 0080 完全相同的盲区。

### 次生缺陷：PGlite 模板静默过期

排查过程中发现第二个独立缺陷：`createPGliteInstanceFromTemplate()`
**同步**加载 `.test-cache/pglite-template.tgz` 且**不校验是否过期**；
过期校验只存在于 `ensurePGliteTemplateCached()`，而后者仅在
`deno.json` 的 `test` 任务里被调用，**`test:domain` / `test:shared` / `test:parallel`
都不调用**。

后果：改了 `schema-ddl.ts` 后只跑 `deno task test:domain community`
会复用旧模板 → `insert into community_posts (... is_official ...)` 以
`column "is_official" does not exist` 失败 → **27 个用例失败**，
表现为产品缺陷而非缓存问题（实测复现）。

## Decision

1. **修复快照链**：把 `public.search_entries` 的定义补回
   `0076` – `0081` 全部受影响快照（定义取自 0075，期间无迁移改动该表）。
   修复后 `db:generate` 输出 `No schema changes, nothing to migrate`，
   证明快照链与代码真正一致。
2. **新增门禁 `scripts/check-migration-snapshot-chain.ts`**（已接入 `check-ci.ts`）：
   - **单调性**：后一个快照不得比前一个少表 —— 除非该表有显式 `DROP TABLE` 迁移，
     或在 `INTENTIONAL_REMOVALS` 登记了理由（`llm_*` 三表移交 noj-llm-gateway，见 0060）；
   - **代码↔快照一致**：代码中 `pgTable("x")` 的表集合必须都在最新快照里；
   - **快照↔迁移一致**：最新快照的表必须都能在迁移里找到 `CREATE TABLE`；
   - **自检**：解析不到表/快照即判定失败，防止路径漂移后的假绿灯。

### 2026-09-15 升级：从「表名集合」到「结构化摘要」

评审发现上述门禁把每个快照降维成**表名集合**（`tableNamesOf()`），因此
**列与索引的静默丢失完全不被覆盖**：删掉 `0081_snapshot.json` 里
`search_entries.deleted_by_user_ids` 一列，门禁仍打印「通过」并 exit 0，
而 `deno task db:generate` 会因此生成
`ALTER TABLE "search_entries" ADD COLUMN "deleted_by_user_ids" ...`
—— 在已含该列的存量库上以 `column already exists` 失败，与丢表同一失效模式。
删索引同理。同时门禁自测只断言 `listSnapshots(emptyDir).length === 0`
而**从不调用 `checkSnapshotChain()`**，删掉 checker 里的空目录守卫也照样绿。

现已升级为**表 → (列签名, 索引签名, 约束签名)** 的结构化摘要：

- **列签名**覆盖 `(name, type, notNull, primaryKey, default)`，`default` 用
  递归排序对象键的 `canonicalJson()` 稳定序列化（键序不得造成假阳性，
  但数组保持原序 —— 索引列顺序有语义）。
- **索引签名**覆盖 `name + 有序列表表达式 + isUnique + where`（部分索引）。
- **约束签名**覆盖 `uniqueConstraints` / `compositePrimaryKeys` /
  `checkConstraints` / `foreignKeys` 四段。
- 新增 issue kind：`missing_column_in_later_snapshot`、
  `missing_index_in_later_snapshot`，以及四个约束类 kind；旧 kind 语义不变。

**DROP 豁免改为按迁移区间作用域**（评审同时指出的第二处缺陷：旧的
`droppedTableNames()` 是**全局且永久**白名单 —— 任一历史迁移出现过
`DROP TABLE foo`，`foo` 此后从任何快照消失都永久免检，这正是丢表事故
长期漏过的原因之一）。现在某个对象在快照 *N* → *N+1* 之间消失时，
只认**迁移编号 ∈ (N, N+1]** 的显式 `DROP`；不再复用历史豁免。

区间（而非「迁移文件名 == N+1」精确匹配）是必需的：本仓库存在
「快照编号错位」历史 —— 0032 的 `DROP COLUMN` 实际作用在 0031→0032 快照区间，
0054 的加列作用在 0053→0054 区间。仍有 4 处错位无法用区间本地性解释
（快照 54→55 的 `problems.submission_mode`、`problems.artifact_max_size_mb`、
`submissions.artifact_storage_url`、`problems.problems_submission_mode_check`：
0054 明确 `ADD COLUMN`/`ADD CONSTRAINT`，0055 没有任何 DROP 却把它们抹掉），
登记在 `LEGACY_RENUMBERING_ARTIFACTS` 并强制写明证据 —— 它们与本次丢表事故同源，
**不得**被当作「有意删除」。

自测同步补强（`check-migration-snapshot-chain_test.ts`，26 个用例）：
空目录用例改为断言 `checkSnapshotChain()` **本身**报错；新增丢列/丢表/丢索引/
丢唯一约束四类阳性回归（断言具体 kind）；新增「合法显式 DROP 不误报」与
「历史 DROP 不得豁免后续快照丢列」两个反向用例；夹具全部建在临时目录，
不触碰真实 drizzle 目录。门禁 CLI 另支持可选位置参数 `[快照目录]`，
便于把快照复制到临时位置人为损坏后复现，CI 不传参、行为与旧版一致
（退出码与中文文案契约不变）。
3. **修复 PGlite 模板过期**：新增同步指纹 `computeSchemaFingerprintSync()`
   与伴随文件 `pglite-template.schema`；`createPGliteInstanceFromTemplate()`
   在指纹缺失或不匹配时**返回 null 回退到 DDL 慢路径**（正确性优先于速度）。
   另在 `scripts/test-domain.sh` 的 PGlite 模式（无 `DATABASE_URL`）下预重建模板。
4. **补 PGlite DDL 镜像**：`schema-ddl.ts` 同步加 `is_official` 列与官方索引
   （`check-schema-parity.ts` 已自动拦截该遗漏，此处按门禁要求补齐）。

## Alternatives considered

- **只删掉 0082 里那条多余的 `CREATE TABLE`，不修快照链**：
  治标不治本 —— 下一次 `db:generate` 会再次生成，且没有门禁拦住。
- **把 `check-migration-safety.ts` 改成也检查重复建表**：
  该脚本按"单条语句安全性"判定，无法看到"跨迁移的重复"；
  快照链一致性需要独立的仓库级视角。
- **允许快照链丢表、只在 db:generate 后人工 review**：
  依赖人工记忆，且生成的迁移在空库测试下是绿的 —— 正是本次失效的原因。
- **PGlite 模板改为异步加载 + await hash**：
  加载路径被大量同步调用点依赖，改动面过大；同步指纹是等价且更小的改动。
- **把 `INTENTIONAL_REMOVALS` 做成配置文件**：
  当前仅 3 条，内联常量 + 强制写理由的测试更直接。

## Consequences

- **新增迁移必须同时更新快照链**；若确实要删表/删列/删索引，必须先写对应的
  `DROP TABLE` / `DROP COLUMN` / `DROP INDEX`（或 `DROP CONSTRAINT`）迁移，
  否则门禁失败（含明确提示）。
- DROP 豁免**按迁移区间生效**，不再全局永久：历史 `DROP TABLE foo` 不能豁免
  `foo` 在后续快照中再次消失。
- 跨服务移交的表（如 `llm_*`）需在 `INTENTIONAL_REMOVALS` 登记并写明理由；
  历史上无法用区间本地性解释的 4 条结构错位在 `LEGACY_RENUMBERING_ARTIFACTS`
  登记并附证据，新增条目必须写明来源迁移。
- PGlite 模板多了 `pglite-template.schema` 伴随文件；指纹不匹配时
  测试会回退到 DDL 慢路径（本地多花数秒），换来"不会静默用错 schema"。
- 本次修复未改变任何生产 schema：`0082_orange_omega_red.sql` 仅含
  `community_posts.is_official` 加列（带 DEFAULT）与其索引，
  已在**模拟存量库**（应用到 0081 后）上实测通过。
- 该缺陷窗口（PR #473 至本次）内若有人执行过 `db:generate`，会得到含
  `CREATE TABLE search_entries` 的迁移；此类迁移从未合入 `main`，
  故存量部署未被破坏。**建议复核该窗口内的迁移文件确认无同类残留**。
