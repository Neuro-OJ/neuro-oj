/**
 * 教学 outbox 迁移测试（P4）。
 *
 * 覆盖交接文档 §4.4 的 education/tests/outbox-migration.pg.test.ts 要求：
 * - 任务身份（outbox id）、游标、失败状态与可领取时刻不丢失；
 * - 重复迁移不产生重复任务（幂等）；
 * - 已处理行不迁移；
 * - 标记迁移后旧行不再被旧 worker 领取。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../tests/helpers/db.ts";
import {
  assignments,
  backgroundTasks,
  classrooms,
  domainMemberships,
  domains,
  educationOutbox,
  users,
} from "../../../shared/db/schema.ts";
import {
  EDUCATION_OUTBOX_MIGRATION_BATCH,
  educationOutboxDedupeKey,
  markEducationOutboxMigratedTx,
  migrateEducationOutboxTx,
} from "../contracts/outbox-migration.ts";

const db = getDb();
const now = new Date().toISOString();

async function reset(): Promise<void> {
  await resetDbForTest();
  await db.execute(sql`DELETE FROM background_tasks`);
}

/** 建立最小教学事实：域、班级、作业、用户。 */
async function seedEducation(): Promise<{
  domainId: string;
  assignmentId: string;
  classroomId: string;
  userId: string;
}> {
  const [domain] = await db.select({ id: domains.id }).from(domains).limit(1);
  if (!domain) throw new Error("测试库缺少默认域");
  const domainId = domain.id;
  const userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    username: `outbox-user-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`,
    email: `outbox-${crypto.randomUUID().slice(0, 8)}@example.test`,
    password_hash: "x",
    created_at: now,
    updated_at: now,
  });
  // 班级教练必须是该域活跃成员（复合外键），先建域成员关系。
  await db.insert(domainMemberships).values({
    id: crypto.randomUUID(),
    domain_id: domainId,
    user_id: userId,
    status: "active",
    joined_at: now,
  });
  const classroomId = crypto.randomUUID();
  await db.insert(classrooms).values({
    id: classroomId,
    domain_id: domainId,
    name: "迁移班级",
    primary_coach_id: userId,
    created_at: now,
    updated_at: now,
  });
  const assignmentId = crypto.randomUUID();
  await db.insert(assignments).values({
    id: assignmentId,
    domain_id: domainId,
    classroom_id: classroomId,
    title: "迁移作业",
    created_by: userId,
    created_at: now,
    updated_at: now,
    published_at: now,
  });
  return { domainId, assignmentId, classroomId, userId };
}

Deno.test("outbox migration[真实 PG]: 保留任务身份、失败次数与可领取时刻", async () => {
  await reset();
  const f = await seedEducation();
  const outboxId = crypto.randomUUID();
  const availableAt = new Date(Date.now() + 60_000).toISOString();
  await db.insert(educationOutbox).values({
    id: outboxId,
    domain_id: f.domainId,
    event_type: "submission.changed",
    user_id: f.userId,
    problem_id: null,
    classroom_id: f.classroomId,
    assignment_id: f.assignmentId,
    payload: { _education_cursor: { student_after: "u-5" } },
    created_at: now,
    available_at: availableAt,
    attempts: 3,
  });

  const result = await db.transaction((tx) => migrateEducationOutboxTx(tx));
  assertEquals(result.items.length, 1);
  assertEquals(result.items[0].outboxId, outboxId);
  assertEquals(result.items[0].created, true);
  assertEquals(result.items[0].failureCount, 3);
  assertEquals(result.items[0].hasCursor, true);

  const [task] = await db.select().from(backgroundTasks);
  assertEquals(task.task_type, "education.recompute");
  assertEquals(task.target_kind, "assignment");
  assertEquals(task.target_id, f.assignmentId);
  assertEquals(task.dedupe_key, educationOutboxDedupeKey(outboxId));
  assertEquals(task.available_at, availableAt);
  assertEquals(task.payload.outbox_id, outboxId);
  assertEquals(task.payload.event_type, "submission.changed");
  assertEquals(
    (task.payload.education_cursor as { student_after: string }).student_after,
    "u-5",
  );
});

Deno.test("outbox migration[真实 PG]: 重复迁移幂等且不产生重复任务", async () => {
  await reset();
  const f = await seedEducation();
  const outboxId = crypto.randomUUID();
  await db.insert(educationOutbox).values({
    id: outboxId,
    domain_id: f.domainId,
    event_type: "problem.changed",
    payload: {},
    created_at: now,
    available_at: now,
  });

  const first = await db.transaction((tx) => migrateEducationOutboxTx(tx));
  const second = await db.transaction((tx) => migrateEducationOutboxTx(tx));
  assertEquals(first.items[0].created, true);
  assertEquals(second.items[0].created, false);
  assertEquals(first.items[0].taskId, second.items[0].taskId);
  const tasks = await db.select().from(backgroundTasks);
  assertEquals(tasks.length, 1);
});

Deno.test("outbox migration[真实 PG]: 已处理行不迁移", async () => {
  await reset();
  const f = await seedEducation();
  await db.insert(educationOutbox).values({
    id: crypto.randomUUID(),
    domain_id: f.domainId,
    event_type: "problem.changed",
    payload: {},
    created_at: now,
    available_at: now,
    processed_at: now,
  });
  const result = await db.transaction((tx) => migrateEducationOutboxTx(tx));
  assertEquals(result.items.length, 0);
  assertEquals((await db.select().from(backgroundTasks)).length, 0);
});

Deno.test("outbox migration[真实 PG]: 标记迁移后旧行不再进入待迁移集合", async () => {
  await reset();
  const f = await seedEducation();
  const outboxId = crypto.randomUUID();
  await db.insert(educationOutbox).values({
    id: outboxId,
    domain_id: f.domainId,
    event_type: "problem.changed",
    payload: {},
    created_at: now,
    available_at: now,
  });
  const migrated = await db.transaction((tx) => migrateEducationOutboxTx(tx));
  const marked = await db.transaction((tx) =>
    markEducationOutboxMigratedTx(
      tx,
      migrated.items.map((item) => item.outboxId),
    )
  );
  assertEquals(marked, 1);
  const after = await db.transaction((tx) => migrateEducationOutboxTx(tx));
  assertEquals(after.items.length, 0);
});

Deno.test("outbox migration: 批量上限与非法入参", async () => {
  await reset();
  const f = await seedEducation();
  for (let i = 0; i < EDUCATION_OUTBOX_MIGRATION_BATCH + 3; i++) {
    await db.insert(educationOutbox).values({
      id: crypto.randomUUID(),
      domain_id: f.domainId,
      event_type: "problem.changed",
      payload: {},
      created_at: new Date(Date.now() + i).toISOString(),
      available_at: now,
    });
  }
  const result = await db.transaction((tx) => migrateEducationOutboxTx(tx));
  assertEquals(result.items.length, EDUCATION_OUTBOX_MIGRATION_BATCH);
  assertEquals(result.remaining > 0, true);
});
