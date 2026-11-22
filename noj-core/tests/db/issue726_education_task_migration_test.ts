/**
 * #726 迁移 0145 的存量数据回归测试（真实 PostgreSQL）。
 *
 * 测试库已迁移到最新（`education_outbox` 已删除），这里按 0116 / 0117 / 0123
 * 的定义重建旧表、唯一索引与外键，写入存量探针后执行 0145 的真实语句：
 *
 * 1. 未处理事件的 v1 任务改写为 v2 payload，保留游标与延迟失效标记；
 * 2. 未处理但没有任务的事件补登记 v2 任务；
 * 3. 已处理事件的 v1 任务直接收尾；
 * 4. 未完成的刷新改用 `refresh:<user_id>` 去重键，升级后同一作业 + 学生的
 *    新刷新请求与之合并，不并存第二条未完成任务。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { dirname, fromFileUrl, resolve } from "jsr:@std/path@^1";
import { getDb } from "../../src/shared/db/connection.ts";
import { unwrapRows } from "../../src/shared/base/sql-rows.ts";
import { DEFAULT_DOMAIN_ID } from "../../src/shared/workspace/types.ts";
import { enqueueEducationRefreshTx } from "../../src/modules/education/contracts/facts.ts";

const MIGRATION_PATH = resolve(
  dirname(fromFileUrl(import.meta.url)),
  "../../drizzle/0145_wet_skaar.sql",
);
const OLD = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const ASSIGNMENT = "issue726-migration-assignment";
const STUDENT = "issue726-migration-student";

function readMigrationStatements(): string[] {
  const content = Deno.readTextFileSync(MIGRATION_PATH);
  return content
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split("--> statement-breakpoint")
    .map((s) => s.trim().replace(/;+$/, "").trim())
    .filter((s) => s.length > 0);
}

/** 按旧迁移重建 outbox 表、待处理刷新唯一索引与通知外键（外键 NOT VALID，不校验存量通知）。 */
async function recreateLegacyOutbox(): Promise<void> {
  const db = getDb();
  await db.execute(sql.raw(`CREATE TABLE "education_outbox" (
    "id" text PRIMARY KEY NOT NULL,
    "domain_id" text NOT NULL,
    "event_type" text NOT NULL,
    "user_id" text,
    "problem_id" text,
    "classroom_id" text,
    "assignment_id" text,
    "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
    "created_at" text NOT NULL,
    "available_at" text NOT NULL,
    "leased_until" text,
    "lease_token" text,
    "attempts" integer DEFAULT 0 NOT NULL,
    "processed_at" text,
    "last_error" text
  )`));
  await db.execute(sql.raw(
    `CREATE UNIQUE INDEX "education_outbox_pending_refresh_unique" ON "education_outbox" ("domain_id","assignment_id",COALESCE("user_id", '')) WHERE "event_type" = 'assignment.refresh' AND "processed_at" IS NULL`,
  ));
  await db.execute(sql.raw(
    `ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_education_outbox_id_fk" FOREIGN KEY ("event_id") REFERENCES "education_outbox"("id") NOT VALID`,
  ));
}

async function insertOutbox(row: {
  id: string;
  event_type: string;
  user_id?: string;
  assignment_id?: string;
  payload?: Record<string, unknown>;
  available_at?: string;
  processed_at?: string;
}): Promise<void> {
  await getDb().execute(sql`INSERT INTO education_outbox
    (id, domain_id, event_type, user_id, assignment_id, payload, created_at, available_at, processed_at)
    VALUES (${row.id}, ${DEFAULT_DOMAIN_ID}, ${row.event_type}, ${
    row.user_id ?? null
  },
      ${row.assignment_id ?? null}, ${JSON.stringify(row.payload ?? {})}::jsonb,
      ${OLD}, ${row.available_at ?? OLD}, ${row.processed_at ?? null})`);
}

/** 旧实现登记的 v1 任务：payload 只有 outbox_id，去重键 `outbox:<id>`。 */
async function insertV1Task(row: {
  id: string;
  outboxId: string;
  assignmentId?: string;
  status?: string;
  availableAt?: string;
}): Promise<void> {
  await getDb().execute(sql`INSERT INTO background_tasks
    (id, task_type, target_kind, target_id, dedupe_key, payload_version, payload, status, available_at, created_at, updated_at)
    VALUES (${row.id}, 'education.recompute',
      ${row.assignmentId ? "assignment" : "domain"},
      ${row.assignmentId ?? DEFAULT_DOMAIN_ID}, ${"outbox:" + row.outboxId}, 1,
      ${JSON.stringify({ outbox_id: row.outboxId })}::jsonb,
      ${row.status ?? "pending"}, ${row.availableAt ?? OLD}, ${OLD}, ${OLD})`);
}

type TaskRow = {
  id: string;
  status: string;
  payload_version: number;
  dedupe_key: string;
  available_at: string;
  payload: Record<string, unknown>;
};

async function educationTasks(): Promise<TaskRow[]> {
  return unwrapRows<TaskRow>(
    await getDb().execute(sql`SELECT id, status, payload_version, dedupe_key,
      available_at, payload FROM background_tasks
      WHERE task_type = 'education.recompute' ORDER BY id`) as never,
  );
}

Deno.test("迁移 0145[真实 PG]: 存量教学事件转为 v2 任务，未完成刷新与新请求合并", async () => {
  const db = getDb();
  await db.execute(sql`DELETE FROM background_tasks`);
  await recreateLegacyOutbox();
  try {
    // 未处理 + 已有 v1 任务（带分页游标、延迟失效标记，到期时间在未来）
    await insertOutbox({
      id: "o-pending",
      event_type: "submission.changed",
      user_id: STUDENT,
      payload: {
        contest_id: "c1",
        _invalidate_on_claim: true,
        _education_cursor: { assignment_after: "a0" },
      },
      available_at: FUTURE,
    });
    await insertV1Task({
      id: "t-pending",
      outboxId: "o-pending",
      availableAt: FUTURE,
    });
    // 已处理 + v1 任务仍 pending
    await insertOutbox({
      id: "o-done",
      event_type: "module.changed",
      processed_at: LATER,
    });
    await insertV1Task({ id: "t-done", outboxId: "o-done" });
    // 未处理 + 没有任务（早期 rc 数据）
    await insertOutbox({ id: "o-orphan", event_type: "problem.changed" });
    // 未处理的刷新 + v1 任务
    await insertOutbox({
      id: "o-refresh",
      event_type: "assignment.refresh",
      user_id: STUDENT,
      assignment_id: ASSIGNMENT,
    });
    await insertV1Task({
      id: "t-refresh",
      outboxId: "o-refresh",
      assignmentId: ASSIGNMENT,
    });

    const statements = readMigrationStatements();
    assert(statements.length > 0, "0145 迁移文件不应为空");
    for (const stmt of statements) await db.execute(sql.raw(stmt));

    const legacy = unwrapRows<{ name: string | null }>(
      await db.execute(
        sql`SELECT to_regclass('education_outbox')::text AS name`,
      ) as never,
    );
    assertEquals(legacy[0].name, null);

    const tasks = await educationTasks();
    const byId = new Map(tasks.map((t) => [t.id, t]));

    const pending = byId.get("t-pending")!;
    assertEquals(pending.status, "pending");
    assertEquals(pending.payload_version, 2);
    assertEquals(pending.available_at, FUTURE);
    assertEquals(pending.payload.event_id, "o-pending");
    assertEquals(pending.payload.event_type, "submission.changed");
    assertEquals(pending.payload.user_id, STUDENT);
    assertEquals(pending.payload.data, {
      contest_id: "c1",
      _invalidate_on_claim: true,
      _education_cursor: { assignment_after: "a0" },
    });

    const done = byId.get("t-done")!;
    assertEquals(done.status, "succeeded");
    assertEquals(done.payload_version, 1);

    const orphan = tasks.find((t) => t.dedupe_key === "outbox:o-orphan");
    assert(orphan, "未处理且无任务的事件应补登记任务");
    assertEquals(orphan.status, "pending");
    assertEquals(orphan.payload_version, 2);
    assertEquals(orphan.payload.event_id, "o-orphan");

    const refresh = byId.get("t-refresh")!;
    assertEquals(refresh.status, "pending");
    assertEquals(refresh.payload_version, 2);
    assertEquals(refresh.dedupe_key, `refresh:${STUDENT}`);

    // 升级后同一作业 + 学生再次请求刷新：合并到存量任务，不新增第二条。
    await db.transaction((tx) =>
      enqueueEducationRefreshTx(tx, DEFAULT_DOMAIN_ID, ASSIGNMENT, STUDENT)
    );
    const refreshes = (await educationTasks()).filter((t) =>
      t.payload.event_type === "assignment.refresh" && t.status === "pending"
    );
    assertEquals(refreshes.map((t) => t.id), ["t-refresh"]);
  } finally {
    await db.execute(sql`DELETE FROM background_tasks`);
    await db.execute(sql.raw(
      `ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_event_id_education_outbox_id_fk"`,
    ));
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "education_outbox"`));
  }
});
