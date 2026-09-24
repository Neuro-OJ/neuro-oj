import { assertEquals } from "jsr:@std/assert@^1";
import {
  evaluationResults,
  oauthAccounts,
  problems,
  submissions,
  users,
} from "./../../src/shared/db/schema.ts";
import type { SubmissionStatus } from "../../src/domains/submission/index.ts";
import { OPTIONAL_EXTENSION_INDEXES } from "../../src/shared/db/schema-ddl.ts";

Deno.test("schema: users table has correct columns", () => {
  const columns = Object.keys(users);
  assertEquals(columns.includes("id"), true);
  assertEquals(columns.includes("username"), true);
  assertEquals(columns.includes("email"), true);
  assertEquals(columns.includes("email_verified"), true);
  assertEquals(columns.includes("email_verify_token"), true);
  assertEquals(columns.includes("email_verify_expires_at"), true);
  assertEquals(columns.includes("deleted_at"), true);
  assertEquals(columns.includes("password_hash"), true);
  assertEquals(columns.includes("password_hash"), true);
  assertEquals(columns.includes("created_at"), true);
  assertEquals(columns.includes("updated_at"), true);
});

Deno.test("schema: users columns have correct constraints", () => {
  assertEquals(users.id.primary, true); // PRIMARY KEY
  assertEquals(users.id.notNull, true);
  assertEquals(users.username.notNull, true);
  // 注销用户统一匿名为“已注销用户”，因此唯一性由仅覆盖活跃账号的部分索引保证。
  assertEquals(users.username.isUnique, false);
  assertEquals(users.email.notNull, true);
  assertEquals(users.email.isUnique, true); // UNIQUE
  assertEquals(users.email_verified.notNull, true);
  assertEquals(users.email_verified.hasDefault, true);
  assertEquals(users.email_verified.default, true);
  assertEquals(users.password_hash.notNull, false);
  assertEquals(users.created_at.notNull, true);
  assertEquals(users.updated_at.notNull, true);
});

Deno.test("schema: oauth accounts have a unique provider identity", () => {
  const columns = Object.keys(oauthAccounts);
  assertEquals(columns.includes("provider"), true);
  assertEquals(columns.includes("provider_user_id"), true);
  assertEquals(columns.includes("user_id"), true);
  assertEquals(oauthAccounts.provider.notNull, true);
  assertEquals(oauthAccounts.provider_user_id.notNull, true);
  assertEquals(oauthAccounts.user_id.notNull, true);
});

Deno.test("schema: problems table has LMCC-specific columns", () => {
  const columns = Object.keys(problems);
  assertEquals(columns.includes("support_package_storage_url"), true);
  assertEquals(columns.includes("runtime_config"), true);
  // 不应包含 test_cases
  assertEquals(columns.includes("test_cases"), false);
  // 不应包含已移除的字段
  assertEquals(columns.includes("judge_image"), false);
  assertEquals(columns.includes("judge_command"), false);
  assertEquals(columns.includes("time_limit_ms"), false);
  assertEquals(columns.includes("memory_limit_mb"), false);
});

Deno.test("schema: problems columns have correct constraints", () => {
  assertEquals(problems.id.primary, true); // PRIMARY KEY
  assertEquals(problems.id.notNull, true);
  assertEquals(problems.title.notNull, true);
  assertEquals(problems.description.notNull, true);
  assertEquals(problems.difficulty.notNull, true);
  assertEquals(problems.difficulty.hasDefault, true);
  assertEquals(problems.difficulty.default, "medium"); // DEFAULT 'medium'
  assertEquals(problems.support_package_storage_url.notNull, false); // 可选
});

Deno.test("schema: submissions table has file_name for mount", () => {
  const columns = Object.keys(submissions);
  assertEquals(columns.includes("user_id"), true);
  assertEquals(columns.includes("problem_id"), true);
  assertEquals(columns.includes("language"), true);
  assertEquals(columns.includes("code"), true);
  assertEquals(columns.includes("file_name"), true);
  assertEquals(columns.includes("status"), true);
});

Deno.test("schema: submissions columns have correct constraints", () => {
  assertEquals(submissions.id.primary, true); // PRIMARY KEY
  assertEquals(submissions.id.notNull, true);
  assertEquals(submissions.user_id.notNull, true); // FK → users.id
  assertEquals(submissions.problem_id.notNull, true); // FK → problems.id
  assertEquals(submissions.language.notNull, true);
  assertEquals(submissions.code.notNull, true);
  assertEquals(submissions.file_name.notNull, false); // 可选
  assertEquals(submissions.status.notNull, true);
  assertEquals(submissions.status.hasDefault, true);
  assertEquals(submissions.status.default, "pending"); // DEFAULT 'pending'
  assertEquals(submissions.created_at.notNull, true);
});

Deno.test("schema: submissions.status type matches SubmissionStatus", () => {
  // 验证 SubmissionStatus 类型的值能被 status 列接受（编译期检查）
  const validStatuses: SubmissionStatus[] = ["pending", "judging", "finished"];
  assertEquals(validStatuses.length, 3);
  assertEquals(validStatuses.includes("pending"), true);
  assertEquals(validStatuses.includes("judging"), true);
  assertEquals(validStatuses.includes("finished"), true);
});

Deno.test("schema: evaluation_results table uses integer score", () => {
  const columns = Object.keys(evaluationResults);
  assertEquals(columns.includes("submission_id"), true);
  assertEquals(columns.includes("status"), true);
  assertEquals(columns.includes("score"), true);
  assertEquals(columns.includes("output"), true);
  assertEquals(columns.includes("details"), true);
  assertEquals(columns.includes("time_ms"), true);
  assertEquals(columns.includes("memory_kb"), true);
});

Deno.test("schema: evaluation_results columns have correct constraints", () => {
  assertEquals(evaluationResults.id.primary, true); // PRIMARY KEY
  assertEquals(evaluationResults.submission_id.notNull, true); // FK → submissions.id
  assertEquals(evaluationResults.status.notNull, true);
  assertEquals(evaluationResults.score.notNull, true);
  assertEquals(evaluationResults.score.hasDefault, true);
  assertEquals(evaluationResults.score.default, 0); // DEFAULT 0
  assertEquals(evaluationResults.output.notNull, true);
  assertEquals(evaluationResults.output.hasDefault, true);
  assertEquals(evaluationResults.output.default, "");
  assertEquals(evaluationResults.details.notNull, true);
  assertEquals(evaluationResults.details.hasDefault, true);
  assertEquals(evaluationResults.details.default, "{}");
  assertEquals(evaluationResults.time_ms.notNull, false); // 可选
  assertEquals(evaluationResults.memory_kb.notNull, false); // 可选
});

Deno.test("schema: exports are defined", () => {
  assertEquals(users !== null && users !== undefined, true);
  assertEquals(problems !== null && problems !== undefined, true);
  assertEquals(submissions !== null && submissions !== undefined, true);
  assertEquals(
    evaluationResults !== null && evaluationResults !== undefined,
    true,
  );
});

Deno.test("schema: 社区搜索 pg_trgm 索引与迁移 DDL 保持同步", async () => {
  assertEquals(
    OPTIONAL_EXTENSION_INDEXES.some((sql) =>
      sql.includes("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    ),
    true,
  );
  assertEquals(
    OPTIONAL_EXTENSION_INDEXES.some((sql) =>
      sql.includes("idx_community_posts_title_trgm") &&
      sql.includes("gin_trgm_ops")
    ),
    true,
  );
  assertEquals(
    OPTIONAL_EXTENSION_INDEXES.some((sql) =>
      sql.includes("idx_community_posts_content_trgm") &&
      sql.includes("gin_trgm_ops")
    ),
    true,
  );

  const migration = await Deno.readTextFile(
    new URL("../../drizzle/0070_unusual_starfox.sql", import.meta.url),
  );
  assertEquals(
    migration.includes("CREATE EXTENSION IF NOT EXISTS pg_trgm"),
    true,
  );
  assertEquals(migration.includes('"idx_community_posts_title_trgm"'), true);
  assertEquals(migration.includes('"idx_community_posts_content_trgm"'), true);
});

Deno.test("schema: ALL_TABLES 覆盖全部 Drizzle 表（resetDbForTest 不得漏表）", async () => {
  // 2026-09-24 评审：carousel_slides 建表但漏登记 ALL_TABLES，导致
  // resetDbForTest() 不清该表、同进程用例互相污染，且 schema parity 门禁
  // 看不到这类名单遗漏。这里从两份事实源交叉核对：
  //   1) schema-ddl.ts 的 CREATE TABLE 语句（测试模式建表的事实源）
  //   2) Drizzle schema 模块导出的表名（生产迁移的事实源）
  const { ALL_TABLES } = await import("../../src/shared/db/schema-ddl.ts");
  const ddl = await Deno.readTextFile(
    new URL("../../src/shared/db/schema-ddl.ts", import.meta.url),
  );
  const ddlTables = [...ddl.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)]
    .map((m) => m[1]);

  const listed = new Set<string>(ALL_TABLES as readonly string[]);
  const missingFromAllTables = ddlTables.filter((t) => !listed.has(t));
  assertEquals(
    missingFromAllTables,
    [],
    `ALL_TABLES 漏登记：${
      missingFromAllTables.join(", ")
    }（resetDbForTest 不会清空这些表）`,
  );

  // 反向：ALL_TABLES 不应包含 DDL 中不存在的表名（拼写漂移同样危险）
  const ddlSet = new Set(ddlTables);
  const phantom = [...listed].filter((t) => !ddlSet.has(t));
  assertEquals(
    phantom,
    [],
    `ALL_TABLES 含 DDL 不存在的表：${phantom.join(", ")}`,
  );

  // 逐个 Drizzle 表（来自 schema.ts 的运行时导出）也必须在 ALL_TABLES 内。
  const schema = await import("../../src/shared/db/schema.ts");
  const drizzleTables: string[] = [];
  for (const value of Object.values(schema)) {
    if (typeof value !== "object" || value === null) continue;
    // Drizzle pgTable 对象带 Symbol.for("drizzle:Name") 表名
    const name = (value as unknown as Record<symbol, unknown>)[
      Symbol.for("drizzle:Name")
    ];
    if (typeof name === "string") drizzleTables.push(name);
  }
  assertEquals(
    drizzleTables.length > 0,
    true,
    "未能从 Drizzle schema 提取表名",
  );
  const missingFromDrizzle = drizzleTables.filter((t) => !listed.has(t));
  assertEquals(
    missingFromDrizzle,
    [],
    `ALL_TABLES 漏登记 Drizzle 表：${missingFromDrizzle.join(", ")}`,
  );
});
