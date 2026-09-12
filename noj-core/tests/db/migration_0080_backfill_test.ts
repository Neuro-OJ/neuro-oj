/**
 * 迁移 0080 升级路径回归测试（存量库加列 + 回填）。
 *
 * 背景：`drizzle/0080_woozy_romulus.sql` 由 drizzle-kit 生成为四条
 * `ADD COLUMN "updated_at" text NOT NULL`（无 DEFAULT、无回填）。PostgreSQL 允许
 * **空表**直接添加 NOT NULL 列，因此唯一执行文件迁移的测试
 * （`tests/00_migrate_test.ts`，跑在空库上）无法发现该缺陷；只有**存量库**升级时
 * 才会失败，而失败会让整批迁移回滚、core 无法启动。
 *
 * 本测试构造"存量库"前置状态——把四张表的 `updated_at` 列删掉并写入代表性数据——
 * 然后**直接执行真实迁移文件中的语句**，断言：
 *   1. 每条加列语句都是可空加列（不允许 `ADD COLUMN ... NOT NULL` 一步式）；
 *   2. 在有数据的表上执行不报错；
 *   3. 回填值取自 `created_at`（而非执行时刻）；
 *   4. 执行后列确为 NOT NULL（约束真的生效，不是"看起来通过"）。
 *
 * 依赖 preload 的每用例事务回滚：DROP/ADD COLUMN 与插入的探针数据都会自动回滚，
 * 不污染其他用例。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { dirname, fromFileUrl, resolve } from "jsr:@std/path@^1";
import { getDb } from "../../src/shared/db/connection.ts";
import { unwrapRows } from "../../src/shared/base/sql-rows.ts";

/** 覆盖本次迁移涉及的全部表 */
const TABLES = [
  "community_reports",
  "community_sanctions",
  "ip_bans",
  "user_bans",
] as const;

/** 探针用户：四张表均有指向 users.id 的外键，需要一个真实用户才能插入数据 */
const PROBE_USER_ID = "00000000-0000-4000-8000-000000000080";
const PROBE_USERNAME = "migration_0080_probe";
/** 固定的"历史"时间戳：用于断言回填值等于 created_at，而非 now() */
const PROBE_CREATED_AT = "2024-01-02T03:04:05.000Z";

const MIGRATION_PATH = resolve(
  dirname(fromFileUrl(import.meta.url)),
  "../../drizzle/0080_woozy_romulus.sql",
);

/**
 * 读取迁移文件并按 drizzle 的语句分隔标记切分为单条语句。
 *
 * 同时剥离 `--` 行注释：本文件顶部有整段中文说明，其中引用了"错误写法"的示例
 * 文本（`ADD COLUMN ... NOT NULL`），若不剥离会让静态断言对自己的说明文字误报。
 * 迁移 SQL 中不存在含 `--` 的字符串字面量，按行剥离是安全的。
 */
function readMigrationStatements(): string[] {
  const content = Deno.readTextFileSync(MIGRATION_PATH);
  const withoutComments = content
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  return withoutComments
    .split("--> statement-breakpoint")
    .map((s) => s.trim().replace(/;+$/, "").trim())
    .filter((s) => s.length > 0);
}

Deno.test({
  name: "migration: 0080 每条加列语句都必须可空加列（禁止一步式 NOT NULL）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    const statements = readMigrationStatements();
    assert(statements.length > 0, "0080 迁移文件不应为空");
    for (const stmt of statements) {
      if (/ADD\s+COLUMN/i.test(stmt)) {
        assert(
          !/NOT\s+NULL/i.test(stmt),
          `0080 出现一步式 NOT NULL 加列（存量库必失败）：\n${stmt}`,
        );
      }
    }
    // 三张表各三步：加列 / 回填 / 置 NOT NULL
    for (const table of TABLES) {
      const scoped = statements.filter((s) => s.includes(`"${table}"`));
      assertEquals(
        scoped.length,
        3,
        `表 ${table} 应有三步（加列/回填/置 NOT NULL），实际 ${scoped.length} 步`,
      );
      assert(/ADD\s+COLUMN/i.test(scoped[0]), `${table} 第一步应为加列`);
      assert(/UPDATE/i.test(scoped[1]), `${table} 第二步应为回填`);
      assert(
        /SET\s+NOT\s+NULL/i.test(scoped[2]),
        `${table} 第三步应为 SET NOT NULL`,
      );
    }
  },
});

Deno.test({
  name: "migration: 0080 在存量数据上执行成功并正确回填",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();

    // ── 1. 构造"存量库"前置状态：删除 updated_at（= 0080 执行前的形态）──
    for (const table of TABLES) {
      await db.execute(
        sql.raw(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "updated_at"`),
      );
    }

    // ── 2. 写入代表性数据（真实升级场景中这些表在迁移前就有数据）──
    await db.execute(sql`
      INSERT INTO users (id, username, email, created_at, updated_at)
      VALUES (${PROBE_USER_ID}, ${PROBE_USERNAME}, ${
      PROBE_USERNAME + "@example.test"
    },
              ${PROBE_CREATED_AT}, ${PROBE_CREATED_AT})
      ON CONFLICT (id) DO NOTHING
    `);
    // community_reports 有 target_check（post_id/comment_id/message_id 三选一非空），
    // 因此需要构造一个真实的举报目标（板块 → 帖子），不能只塞空值。
    await db.execute(sql`
      INSERT INTO community_boards (id, slug, name, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-000000000086', 'migration-0080-probe',
              '迁移回填回归板块', ${PROBE_CREATED_AT}, ${PROBE_CREATED_AT})
    `);
    await db.execute(sql`
      INSERT INTO community_posts
        (id, type, board_id, title, author_id, content, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-000000000087', 'discussion',
              '00000000-0000-4000-8000-000000000086', '迁移回填回归帖子',
              ${PROBE_USER_ID}, '正文', ${PROBE_CREATED_AT}, ${PROBE_CREATED_AT})
    `);
    await db.execute(sql`
      INSERT INTO community_reports
        (id, reporter_id, post_id, reason, content_snapshot, created_at)
      VALUES ('00000000-0000-4000-8000-000000000081', ${PROBE_USER_ID},
              '00000000-0000-4000-8000-000000000087',
              '迁移回填回归', 'snapshot', ${PROBE_CREATED_AT})
    `);
    await db.execute(sql`
      INSERT INTO community_sanctions (id, user_id, reason, created_at)
      VALUES ('00000000-0000-4000-8000-000000000082', ${PROBE_USER_ID},
              '迁移回填回归', ${PROBE_CREATED_AT})
    `);
    await db.execute(sql`
      INSERT INTO ip_bans (id, ip_or_cidr, reason, created_at)
      VALUES ('00000000-0000-4000-8000-000000000083', '203.0.113.99',
              '迁移回填回归', ${PROBE_CREATED_AT})
    `);
    await db.execute(sql`
      INSERT INTO user_bans (id, user_id, reason, banned_at)
      VALUES ('00000000-0000-4000-8000-000000000084', ${PROBE_USER_ID},
              '迁移回填回归', ${PROBE_CREATED_AT})
    `);

    // 前置条件自检：确认真的构造出了"有数据且无 updated_at 列"的状态。
    // 没有这一步，测试可能在空表上"通过"——正是原缺陷逃逸的原因。
    for (const table of TABLES) {
      const cols = unwrapRows<{ n: number }>(
        await db.execute(sql`
          SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = ${table}
            AND column_name = 'updated_at'
        `),
      );
      assertEquals(
        Number(cols[0]?.n ?? -1),
        0,
        `${table}.updated_at 应已被删除（前置条件未构造成功）`,
      );
      const rows = unwrapRows<{ n: number }>(
        await db.execute(sql.raw(`SELECT count(*)::int AS n FROM "${table}"`)),
      );
      assert(
        Number(rows[0]?.n ?? 0) > 0,
        `${table} 必须有存量数据，否则本测试退化为"空库测试"`,
      );
    }

    // ── 3. 执行真实迁移文件（0080 的全部语句）──
    for (const stmt of readMigrationStatements()) {
      await db.execute(sql.raw(stmt));
    }

    // ── 4. 断言结果 ──
    for (const table of TABLES) {
      const cols = unwrapRows<{ is_nullable: string; n: number }>(
        await db.execute(sql`
          SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = ${table}
            AND column_name = 'updated_at'
        `),
      );
      assertEquals(
        Number(cols.length),
        1,
        `${table}.updated_at 应已存在`,
      );
      assertEquals(
        cols[0].is_nullable,
        "NO",
        `${table}.updated_at 应为 NOT NULL`,
      );
    }

    // 回填值必须来自各自的"创建时刻"列，而不是 now()
    // 注意：user_bans 没有 created_at，其时间基准是 banned_at。
    const backfilled = unwrapRows<{ table_name: string; ok: boolean }>(
      await db.execute(sql`
        SELECT 'community_reports' AS table_name,
               bool_and(updated_at = created_at) AS ok FROM community_reports
        UNION ALL
        SELECT 'community_sanctions', bool_and(updated_at = created_at) FROM community_sanctions
        UNION ALL
        SELECT 'ip_bans', bool_and(updated_at = created_at) FROM ip_bans
        UNION ALL
        SELECT 'user_bans', bool_and(updated_at = banned_at) FROM user_bans
      `),
    );
    for (const row of backfilled) {
      assertEquals(
        row.ok,
        true,
        `${row.table_name}.updated_at 回填值应等于 created_at`,
      );
    }

    // 约束真的生效：显式插入 NULL 必须被拒绝
    let rejected = false;
    try {
      await db.execute(sql`
        INSERT INTO ip_bans (id, ip_or_cidr, reason, created_at, updated_at)
        VALUES ('00000000-0000-4000-8000-000000000085', '203.0.113.100',
                '约束生效验证', ${PROBE_CREATED_AT}, NULL)
      `);
    } catch {
      rejected = true;
    }
    assert(rejected, "updated_at 为 NOT NULL，插入 NULL 应被数据库拒绝");
  },
});
