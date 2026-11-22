/**
 * 教学事件 → 通用后台任务（真实 PG）。
 *
 * - 教学事件即 `education.recompute` 任务，与业务事实同事务提交或回滚；
 * - 分页结果重新入队，完成后不重复处理；
 * - 补算请求未完成时合并，完成后可再次触发。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import { resetDbForTest } from "../../../../tests/helpers/db.ts";
import {
  assignmentRecipients,
  assignments,
  backgroundTasks,
  classroomMemberships,
  classrooms,
  domainMemberships,
  domains,
  queryProjectionRevisions,
  users,
} from "../../../shared/db/schema.ts";
import {
  EDUCATION_TASK_PAYLOAD_VERSION,
  educationRevisionScope,
  enqueueEducationRefreshTx,
  recordEducationEvent,
  recordEducationNotice,
} from "../contracts/facts.ts";
import { processEducationTask } from "../services/progress-worker.ts";
import {
  claimTasks,
  completeTaskTx,
  getTaskById,
  renewTaskLease,
  rescheduleTaskTx,
} from "../../../shared/tasks/repository.ts";
import {
  type ClaimedTask,
  isTaskRescheduleResult,
} from "../../../shared/tasks/contracts.ts";

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

Deno.test({
  name: "education: 教学事件任务与业务事实同事务提交或回滚",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await reset();
    const f = await seedEducation();
    try {
      await db.transaction(async (tx) => {
        await recordEducationEvent(tx, {
          domain_id: f.domainId,
          assignment_id: f.assignmentId,
          event_type: "assignment.refresh",
        });
        throw new Error("模拟教学事实事务失败");
      });
    } catch {
      // 预期回滚
    }
    assertEquals((await db.select().from(backgroundTasks)).length, 0);

    await db.transaction((tx) =>
      recordEducationEvent(tx, {
        domain_id: f.domainId,
        assignment_id: f.assignmentId,
        event_type: "assignment.refresh",
      })
    );
    const [task] = await db.select().from(backgroundTasks);
    assertEquals(task.task_type, "education.recompute");
    assertEquals(task.payload_version, EDUCATION_TASK_PAYLOAD_VERSION);
    assertEquals(task.target_id, f.assignmentId);
    assertEquals(task.payload.domain_id, f.domainId);
    assertEquals(task.payload.event_type, "assignment.refresh");
    assertEquals(task.dedupe_key, `event:${task.payload.event_id}`);
  },
});

Deno.test({
  name: "education: 分页结果重新入队，完成后不重复处理",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await reset();
    const f = await seedEducation();
    await db.transaction((tx) =>
      recordEducationEvent(tx, {
        domain_id: f.domainId,
        assignment_id: f.assignmentId,
        event_type: "assignment.refresh",
      })
    );

    const [first] = await claimTasks("education-test-1", 1, 60_000, db);
    const firstResult = await processEducationTask(
      first,
      new AbortController().signal,
    );
    if (!isTaskRescheduleResult(firstResult)) {
      throw new Error("第一轮教学任务应返回分页重新调度");
    }
    // 真实 worker 会调用同一仓库原语，确保 handler 返回的分页游标能恢复到
    // 下一轮领取，而不是由测试直接改写任务状态。
    assertEquals(
      await db.transaction((tx) =>
        rescheduleTaskTx(tx, first.id, first.leaseToken, firstResult)
      ),
      true,
    );

    const [second] = await claimTasks("education-test-2", 1, 60_000, db);
    const secondResult = await processEducationTask(
      second,
      new AbortController().signal,
    );
    if (isTaskRescheduleResult(secondResult)) {
      throw new Error("第二轮教学任务不应再次重新调度");
    }
    assertEquals(
      await db.transaction((tx) =>
        completeTaskTx(tx, second.id, second.leaseToken, secondResult ?? {})
      ),
      true,
    );
    assertEquals((await getTaskById(first.id, db))?.status, "succeeded");
  },
});

Deno.test({
  name: "education: 未完成的补算请求合并，完成后再次请求复活同一任务",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await reset();
    const f = await seedEducation();
    const refresh = () =>
      db.transaction((tx) =>
        enqueueEducationRefreshTx(tx, f.domainId, f.assignmentId, f.userId)
      );
    await refresh();
    await refresh();
    const pending = await db.select().from(backgroundTasks);
    assertEquals(pending.length, 1);
    assertEquals(pending[0].status, "pending");

    const [task] = await claimTasks("education-refresh", 1, 60_000, db);
    await refresh();
    assertEquals((await getTaskById(task.id, db))?.status, "leased");
    assertEquals(
      await db.transaction((tx) =>
        completeTaskTx(tx, task.id, task.leaseToken)
      ),
      true,
    );

    await refresh();
    const revived = await db.select().from(backgroundTasks);
    assertEquals(revived.length, 1);
    assertEquals(revived[0].id, task.id);
    assertEquals(revived[0].status, "pending");
    assertEquals(revived[0].finished_at, null);
  },
});

async function domainRevision(domainId: string): Promise<number> {
  const [row] = await db.select({
    revision: queryProjectionRevisions.data_revision,
  })
    .from(queryProjectionRevisions)
    .where(
      eq(queryProjectionRevisions.scope_key, educationRevisionScope(domainId)),
    );
  return row?.revision ?? 0;
}

async function expireLease(taskId: string): Promise<void> {
  await db.update(backgroundTasks).set({
    lease_expiry: "2020-01-01T00:00:00.000Z",
  }).where(eq(backgroundTasks.id, taskId));
}

async function claimOne(leaseMs = 60_000): Promise<ClaimedTask> {
  const [task] = await claimTasks("education-test", 1, leaseMs, db, [
    "education.recompute",
  ]);
  assert(task, "应领取到教学任务");
  return task;
}

Deno.test({
  name: "education: 失去租约不失效，重新领取后只失效一次",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await reset();
    const f = await seedEducation();
    await db.transaction((tx) =>
      recordEducationEvent(tx, {
        domain_id: f.domainId,
        assignment_id: f.assignmentId,
        event_type: "submission.changed",
      }, { availableAt: "2099-01-01T00:00:00.000Z" })
    );
    await db.update(backgroundTasks).set({ available_at: now });
    const before = await domainRevision(f.domainId);

    const stale = await claimOne();
    await expireLease(stale.id);
    const lost = await processEducationTask(
      stale,
      new AbortController().signal,
    );
    assertEquals((lost as Record<string, unknown>).skipped, "lease_lost");
    assertEquals(await domainRevision(f.domainId), before);

    const fresh = await claimOne();
    const result = await processEducationTask(
      fresh,
      new AbortController().signal,
    );
    assertEquals(await domainRevision(f.domainId), before + 1);
    const stored = await getTaskById(fresh.id, db);
    assertEquals(
      (stored?.payload.data as Record<string, unknown>)._invalidate_on_claim,
      false,
    );
    // 同一租约内重复执行（如 worker 重放）不会再次失效。
    if (isTaskRescheduleResult(result)) {
      await processEducationTask(
        { ...fresh, payload: stored!.payload },
        new AbortController().signal,
      );
    }
    assertEquals(await domainRevision(f.domainId), before + 1);
  },
});

/** 有界轮询：条件满足即返回，超时报错（不静默放过）。 */
async function waitFor(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type LockedTable = "assignment_recipients" | "query_projection_revisions";

/**
 * 另一连接以 ACCESS EXCLUSIVE 锁住表，直到调用 `release()`。
 *
 * 取锁失败或超过 `timeoutMs` 未取到锁时抛错；`release()` 等待持锁事务收尾。
 */
async function holdTableLock(
  table: LockedTable,
  timeoutMs = 5_000,
): Promise<{ release: () => Promise<void> }> {
  let locked!: () => void;
  let unlock!: () => void;
  const ready = new Promise<void>((resolve) => (locked = resolve));
  const unlocked = new Promise<void>((resolve) => (unlock = resolve));
  const holder = db.transaction(async (tx) => {
    await tx.execute(sql.raw(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`));
    locked();
    await unlocked;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      holder.then(() => {
        throw new Error(`持锁事务提前结束：${table}`);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`取锁超时：${table}`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    unlock();
    await holder.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    release: async () => {
      unlock();
      await holder;
    },
  };
}

/** 是否已有其他会话在等待该表的锁（即处理器已到达等待点）。 */
async function hasLockWaiter(table: LockedTable): Promise<boolean> {
  return unwrapRows<{ waiting: boolean }>(
    await db.execute(sql`SELECT EXISTS (
      SELECT 1 FROM pg_locks
      WHERE NOT granted AND relation = to_regclass(${table})
    ) AS waiting`) as never,
  )[0].waiting;
}

/** 数据库时钟是否已越过给定时刻（与租约判定使用同一时钟）。 */
async function dbClockPassed(at: string): Promise<boolean> {
  return unwrapRows<{ passed: boolean }>(
    await db.execute(
      sql`SELECT clock_timestamp() > ${at}::timestamptz AS passed`,
    ) as never,
  )[0].passed;
}

Deno.test({
  name: "education: 租约在失效事务中途到期，接手者不重复失效",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await reset();
    const f = await seedEducation();
    await db.transaction((tx) =>
      recordEducationEvent(tx, {
        domain_id: f.domainId,
        assignment_id: f.assignmentId,
        event_type: "submission.changed",
      }, { availableAt: "2099-01-01T00:00:00.000Z" })
    );
    await db.update(backgroundTasks).set({ available_at: now });
    const before = await domainRevision(f.domainId);

    // 租约足够长，保证处理器在租约内到达等待点；之后由数据库时钟判定到期再放锁。
    const task = await claimOne(5_000);
    const lock = await holdTableLock("query_projection_revisions");
    let result: unknown;
    try {
      const running = processEducationTask(task, new AbortController().signal);
      await waitFor(
        "处理器等待投影版本表锁",
        () => hasLockWaiter("query_projection_revisions"),
      );
      // 标记已在租约内清除（持有任务行锁），此时租约应仍有效。
      assertEquals(await dbClockPassed(task.leaseExpiry), false);
      await waitFor(
        "租约到期",
        () => dbClockPassed(task.leaseExpiry),
        10_000,
      );
      await lock.release();
      result = await running;
    } finally {
      await lock.release();
    }
    assertEquals((result as Record<string, unknown>).skipped, "lease_lost");
    assertEquals(await domainRevision(f.domainId), before + 1);

    const takeover = await claimOne();
    assertEquals(takeover.id, task.id);
    await processEducationTask(takeover, new AbortController().signal);
    assertEquals(await domainRevision(f.domainId), before + 1);
  },
});

Deno.test({
  name: "education: 失去租约时不持久化游标也不推送 education:sync",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await reset();
    const f = await seedEducation();
    await db.transaction((tx) =>
      recordEducationEvent(tx, {
        domain_id: f.domainId,
        assignment_id: f.assignmentId,
        event_type: "assignment.refresh",
      })
    );
    const countSync = async () =>
      unwrapRows<{ n: number }>(
        await db.execute(
          sql`SELECT count(*)::int AS n FROM sse_events WHERE payload->>'type' = 'education:sync'`,
        ) as never,
      )[0].n;
    const before = await countSync();

    const stale = await claimOne();
    await expireLease(stale.id);
    const lost = await processEducationTask(
      stale,
      new AbortController().signal,
    );
    assertEquals((lost as Record<string, unknown>).skipped, "lease_lost");
    assertEquals(await countSync(), before);
    assertEquals(
      (await getTaskById(stale.id, db))?.payload.data,
      stale.payload.data,
    );

    const fresh = await claimOne();
    const step = await processEducationTask(
      fresh,
      new AbortController().signal,
    );
    assert(isTaskRescheduleResult(step), "首页处理后应重新调度下一页");
    assertEquals(await countSync(), before + 1);
    const cursor = ((await getTaskById(fresh.id, db))?.payload.data as Record<
      string,
      unknown
    >)._education_cursor;
    assertEquals(cursor, { assignment_after: f.assignmentId });
  },
});

Deno.test({
  name: "education: 满页处理超过租期时续租不被挡住，游标照常推进",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await reset();
    const f = await seedEducation();
    const recipients = Array.from({ length: 50 }, (_, i) => ({
      id: `issue726-r-${String(i).padStart(2, "0")}-${
        crypto.randomUUID().slice(0, 6)
      }`,
    }));
    await db.insert(users).values(recipients.map((r) => ({
      id: r.id,
      username: r.id,
      email: `${r.id}@example.test`,
      password_hash: "x",
      created_at: now,
      updated_at: now,
    })));
    await db.insert(domainMemberships).values(recipients.map((r) => ({
      id: crypto.randomUUID(),
      domain_id: f.domainId,
      user_id: r.id,
      status: "active" as const,
      joined_at: now,
    })));
    await db.insert(classroomMemberships).values(recipients.map((r) => ({
      id: crypto.randomUUID(),
      domain_id: f.domainId,
      classroom_id: f.classroomId,
      user_id: r.id,
      role: "student" as const,
      joined_at: now,
      appointed_at: now,
    })));
    await db.insert(assignmentRecipients).values(recipients.map((r) => ({
      id: crypto.randomUUID(),
      domain_id: f.domainId,
      classroom_id: f.classroomId,
      assignment_id: f.assignmentId,
      user_id: r.id,
      added_by: "initial" as const,
      joined_at: now,
    })));
    await db.transaction((tx) =>
      recordEducationNotice(tx, {
        domain_id: f.domainId,
        assignment_id: f.assignmentId,
        type: "assignment_changed",
      })
    );

    const leaseMs = 300;
    const task = await claimOne(leaseMs);
    // 另一连接锁住收件人表：处理器到达等待点后，等原租约在数据库时钟上到期再放锁，
    // 本页处理时间确定地超过原租期，只能靠续租保住租约。
    const lock = await holdTableLock("assignment_recipients");
    let renewing = true, renewals = 0;
    const renewer = (async () => {
      while (renewing) {
        if (await renewTaskLease(task.id, task.leaseToken, leaseMs, db)) {
          renewals++;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
    try {
      const running = processEducationTask(task, new AbortController().signal);
      await waitFor(
        "处理器等待收件人表锁",
        () => hasLockWaiter("assignment_recipients"),
      );
      await waitFor(
        "原租约到期",
        () => dbClockPassed(task.leaseExpiry),
        10_000,
      );
      await lock.release();
      const step = await running;
      assert(isTaskRescheduleResult(step), "满页应推进游标并重新调度");
    } finally {
      renewing = false;
      await renewer;
      await lock.release();
    }
    assert(renewals >= 3, `处理期间续租应持续成功，实际 ${renewals} 次`);
    const data = (await getTaskById(task.id, db))?.payload.data as Record<
      string,
      unknown
    >;
    assertEquals(typeof data._notice_after, "string");
  },
});
