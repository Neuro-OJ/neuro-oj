/**
 * 迁移安全门禁的自测。
 *
 * 门禁本身也必须被测试——否则它可能"永远通过"（本次评审的核心教训）。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  checkMigrationSafety,
  findUnsafeAddColumns,
  isUnsafeNotNullAddColumn,
  splitMigrationStatements,
} from "./check-migration-safety.ts";

Deno.test("migration-safety: 一步式 NOT NULL 加列应被判定为不安全", () => {
  assertEquals(
    isUnsafeNotNullAddColumn(
      `ALTER TABLE "community_reports" ADD COLUMN "updated_at" text NOT NULL`,
    ),
    true,
  );
});

Deno.test("migration-safety: 带 DEFAULT 的加列是安全的", () => {
  assertEquals(
    isUnsafeNotNullAddColumn(
      `ALTER TABLE "t" ADD COLUMN "n" integer NOT NULL DEFAULT 0`,
    ),
    false,
  );
});

Deno.test("migration-safety: 三步式写法的三条语句均不被误报", () => {
  const statements = [
    `ALTER TABLE "t" ADD COLUMN "updated_at" text`,
    `UPDATE "t" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL`,
    `ALTER TABLE "t" ALTER COLUMN "updated_at" SET NOT NULL`,
  ];
  for (const s of statements) {
    assertEquals(isUnsafeNotNullAddColumn(s), false, `误报: ${s}`);
  }
});

Deno.test("migration-safety: 非加列语句不被误报", () => {
  assertEquals(
    isUnsafeNotNullAddColumn(`CREATE TABLE t (id TEXT NOT NULL)`),
    false,
  );
  assertEquals(
    isUnsafeNotNullAddColumn(`ALTER TABLE "t" DROP COLUMN "x"`),
    false,
  );
});

Deno.test("migration-safety: 行注释被剥离，说明文字不产生误报", () => {
  // 真实场景：修正后的 0080 文件顶部引用了"错误写法"作为说明文字。
  const content = [
    `-- 原因：原生成结果为 \`ADD COLUMN "updated_at" text NOT NULL\`，`,
    `-- 在存量库上必然失败。`,
    `ALTER TABLE "t" ADD COLUMN "updated_at" text;--> statement-breakpoint`,
    `UPDATE "t" SET "updated_at" = "created_at";--> statement-breakpoint`,
    `ALTER TABLE "t" ALTER COLUMN "updated_at" SET NOT NULL;`,
  ].join("\n");
  const statements = splitMigrationStatements("mem.sql", content);
  assertEquals(statements.length, 3);
  assertEquals(findUnsafeAddColumns(statements).length, 0);
});

Deno.test("migration-safety: 无分隔标记的多语句块不产生误报（0017 场景）", () => {
  // 真实场景：0017_problem_runtime_config.sql 没有 statement-breakpoint，
  // 同一块里 ADD COLUMN 之后还有 CHECK(... IS NOT NULL) 与 CREATE INDEX ... IS NOT NULL。
  const content = [
    `ALTER TABLE "problems" ADD COLUMN IF NOT EXISTS "runtime_config" jsonb;`,
    ``,
    `ALTER TABLE "problems" ADD CONSTRAINT "problems_runtime_config_check"`,
    `  CHECK ("runtime_config" IS NULL OR jsonb_typeof("runtime_config") = 'object');`,
    ``,
    `CREATE INDEX "problems_runtime_config_present_idx"`,
    `  ON "problems" (id)`,
    `  WHERE "runtime_config" IS NOT NULL;`,
  ].join("\n");
  const statements = splitMigrationStatements("0017_x.sql", content);
  assertEquals(findUnsafeAddColumns(statements).length, 0);
});

Deno.test("migration-safety: 多语句块中的一步式加列仍能被发现（无假阴性）", () => {
  const content = [
    `ALTER TABLE "t" ADD COLUMN "a" text NOT NULL;`,
    `CREATE INDEX i ON t (a) WHERE a IS NOT NULL;`,
  ].join("\n");
  const statements = splitMigrationStatements("mem.sql", content);
  assertEquals(findUnsafeAddColumns(statements).length, 1);
});

Deno.test("migration-safety: 目录不存在时门禁失败（不静默通过）", async () => {
  const errors = await checkMigrationSafety("noj-core/drizzle-does-not-exist");
  assert(errors.length > 0, "目录不存在必须报错");
});

Deno.test("migration-safety: 真实迁移目录当前无一步式 NOT NULL 加列", async () => {
  const errors = await checkMigrationSafety("noj-core/drizzle");
  assertEquals(errors, []);
});
