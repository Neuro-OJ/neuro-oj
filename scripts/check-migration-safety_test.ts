/**
 * 迁移安全门禁的自测。
 *
 * 门禁本身也必须被测试——否则它可能"永远通过"（本次评审的核心教训）。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  checkMigrationSafety,
  findHardcodedPublicSchemaRefs,
  findUnsafeAddColumns,
  hasHardcodedPublicSchemaRef,
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

// ── schema 前缀门禁（2026-09-19 D0 缺口）────────────────────────────────
Deno.test(
  'migration-safety: REFERENCES "public". 前缀被识别（历史 0056/0063/0066 形态）',
  () => {
    const statements = splitMigrationStatements(
      "mem.sql",
      `ALTER TABLE "submissions" ADD CONSTRAINT "fk" FOREIGN KEY ("x") ` +
        `REFERENCES "public"."llm_providers"("id") ON DELETE set null;` +
        `--> statement-breakpoint`,
    );
    assertEquals(findHardcodedPublicSchemaRefs(statements).length, 1);
  },
);

Deno.test("migration-safety: 不带 schema 前缀的 REFERENCES 不误报", () => {
  const statements = splitMigrationStatements(
    "mem.sql",
    `ALTER TABLE "t" ADD CONSTRAINT "fk" FOREIGN KEY ("x") ` +
      `REFERENCES "users"("id") ON DELETE set null;`,
  );
  assertEquals(findHardcodedPublicSchemaRefs(statements).length, 0);
});

Deno.test("migration-safety: 字符串字面量中的 public. 不误报", () => {
  // 只认 REFERENCES 之后的限定符，避免把值里出现的 public 当 schema
  assertEquals(
    hasHardcodedPublicSchemaRef(
      `INSERT INTO "t" ("note") VALUES ('REFERENCES public.foo');`,
    ),
    false,
  );
});

Deno.test(
  "migration-safety: 含 public 前缀的迁移目录整体判定失败（非空转）",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "migration-safety-ref-" });
    try {
      await Deno.writeTextFile(
        `${dir}/0001_demo.sql`,
        `ALTER TABLE "widgets" ADD CONSTRAINT "fk" FOREIGN KEY ("owner_id") ` +
          `REFERENCES "public"."users"("id");`,
      );
      const errors = await checkMigrationSafety(dir);
      assert(
        errors.some((e) => e.includes("public")),
        `必须报出 schema 前缀：${JSON.stringify(errors)}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test("migration-safety: 真实迁移目录已无 public schema 前缀", async () => {
  const errors = await checkMigrationSafety("noj-core/drizzle");
  assertEquals(
    errors.filter((e) => e.includes("public")),
    [],
  );
});
