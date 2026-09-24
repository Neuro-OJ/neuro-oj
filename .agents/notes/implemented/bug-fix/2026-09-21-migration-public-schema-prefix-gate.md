# Agent Note: 迁移硬编码 `REFERENCES "public".` 前缀长期无门禁

Status: implemented

## Problem

`scripts/check-migration-safety.ts` 是仓库级迁移门禁（CI 由 `check-ci.ts` 调用），
但它只拦截「向已有表加 NOT NULL 列但无 DEFAULT」这一种失效模式。
**迁移里硬编码 `REFERENCES "public".<表>` schema 前缀**——另一类会导致分片测试
静默失败、且 `deno task db:generate` 会持续再生成的缺陷——**没有任何静态门禁**。

这不是假设。仓库历史上 `0056_support_user_byok.sql`、`0063_wet_wasp.sql`、
`0066_blue_betty_brant.sql` 三个迁移确实由 drizzle-kit 生成了前缀：

```sql
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_llm_provider_config_id_llm_providers_id_fk"
  FOREIGN KEY ("llm_provider_config_id") REFERENCES "public"."llm_providers"("id") ...;
```

它们靠人工修订去掉（`noj-core/CLAUDE.md` 里有散文约定），但 `noj-core/drizzle.config.ts`
**未设 `schemaFilter`**，因此下一次 `db:generate` 仍会生成前缀，约定会随下一个迁移
回归。D0 排查记录（`dev-docs/unattended/progress-log.md` §「待人工 review 清单」#9）
已经把这条列为「原清单遗漏、建议加静态检查」，本 Note 兑现它。

**为什么它是真缺陷而非风格问题**：分片测试（`scripts/test-parallel.ts`，CI 的
`core-test-sharded` job）用 `TEST_SCHEMA=test_unit/test_db` 让所有连接落在非
`public` schema。带前缀的 FK 会跨 schema 指向 `public.<表>`，于是「父行刚插入却报
FK 失败」——报错与真实原因相距甚远，正是当时排查耗时的主要来源。

### 修复前失败的真实证据

把历史迁移的原始文本放进一个临时迁移目录，用**修复前**的门禁（取自父提交
`zkqtpovz` 的 `scripts/check-migration-safety.ts`）判定：

```text
$ deno eval 'import { checkMigrationSafety } from "/tmp/opencode/check-migration-safety-orig.ts";
  const errs = await checkMigrationSafety("/tmp/opencode/prefix-gate/drizzle");
  console.log("errors.length =", errs.length);'
errors.length = 0
```

即：带 `REFERENCES "public".` 前缀的迁移目录**完全通过**，门禁 exit 0。

## Decision

1. 在 `check-migration-safety.ts` 新增门禁：迁移语句不得含
   `REFERENCES "public".`（大小写不敏感、限定符可有可无引号）。
2. **先剥离字符串字面量再匹配**（`stripSqlStringLiterals`：单引号串与 `$$` 美元引用）。
   初版直接对原句正则匹配，自测立刻抓出一个真实假阳性：
   `INSERT ... VALUES ('REFERENCES public.foo')` 会被误判。DDL 标识符用双引号、
   字符串值用单引号，剥离单引号串不会影响对 `"public".` 的判定，却消除了误报。
3. **加自检防「恒真门禁」**：仓库当前有 0 处前缀，若检测规则失效会永远返回空而
   无人察觉。因此 `checkMigrationSafety` 内置一条**合成语句**自证检测函数可用，
   识别不到即判定门禁失效并失败——与本文件既有「自检 1/自检 2」同源。
4. 新增 5 条回归：历史形态被识别、无前缀不误报、字符串字面量不误报、
   整体目录判定失败（非空转）、真实仓库已无前缀。

## Alternatives considered

- **改 `drizzle.config.ts` 设 `schemaFilter` 从源头不生成前缀**：是更根治的方向，
  但 `schemaFilter` 会改变 drizzle-kit 对已有多 schema 的差异计算，可能影响快照链
  （见 `check-migration-snapshot-chain.ts` 的严格一致性门禁），风险面大且需重新
  验证 `db:generate` 输出。作为**待人工裁决**项记录，不在本修复中自行动；
  静态门禁是零行为变更、可立即生效的兜底。
- **只匹配裸 `public.`（不限 REFERENCES）**：会误报字符串值、注释与其它上下文。
  限定在 `REFERENCES` 之后并剥离字符串，精度最高。
- **把剥离逻辑做成完整 SQL 词法器**：本门禁只需覆盖 drizzle-kit 的固定生成形态
  （`REFERENCES "public"."x"("id")`），完整词法器是过度工程。
- **不加自检**：仓库当前 0 命中，规则失效时门禁恒绿——正是本仓库反复整治的
  「假绿灯」模式。合成语句自检成本极低。

## Consequences

- 新增迁移若带 `REFERENCES "public".`，`deno task`/CI 的仓库级门禁会失败并给出
  可执行提示（去掉 `"public".` 限定符，按 search_path 解析）。
- 门禁对 24 个含 `REFERENCES` 的历史迁移（0010/0027/0029 等）无影响：它们都不带
  schema 前缀，实测 `deno run -A scripts/check-migration-safety.ts` exit 0。
- 检测的**正确性**由字符串剥离保证：值文本不含误报，DDL 标识符不含漏报。
- `schemaFilter` 根治方案作为待人工裁决项，未在本修复中改动生产配置。
