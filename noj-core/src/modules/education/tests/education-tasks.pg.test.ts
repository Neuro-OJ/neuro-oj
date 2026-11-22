/**
 * 教学事件 → 通用后台任务（真实 PG）。
 *
 * - outbox 行与 `education.recompute` 任务同事务提交或回滚；
 * - 分页结果重新入队，完成后不重复处理。
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
import { recordEducationEvent } from "../contracts/facts.ts";
import { handleEducationTask } from "../../application/education-handlers.ts";
import {
    claimTasks,
    completeTaskTx,
    getTaskById,
    rescheduleTaskTx,
} from "../../../shared/tasks/repository.ts";
import { isTaskRescheduleResult } from "../../../shared/tasks/contracts.ts";

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
        username: `outbox-user-${Date.now()}-${
            crypto.randomUUID().slice(0, 6)
        }`,
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

Deno.test("education facts[真实 PG]: outbox 与通用任务同事务提交或回滚", async () => {
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
    assertEquals((await db.select().from(educationOutbox)).length, 0);
    assertEquals((await db.select().from(backgroundTasks)).length, 0);

    await db.transaction((tx) =>
        recordEducationEvent(tx, {
            domain_id: f.domainId,
            assignment_id: f.assignmentId,
            event_type: "assignment.refresh",
        })
    );
    assertEquals((await db.select().from(educationOutbox)).length, 1);
    const [task] = await db.select().from(backgroundTasks);
    assertEquals(task.task_type, "education.recompute");
    assertEquals(
        task.payload.outbox_id,
        (await db.select().from(educationOutbox))[0].id,
    );
});

Deno.test("education background task[真实 PG]: 分页结果重新入队，完成后不重复处理", async () => {
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
    const firstResult = await handleEducationTask(
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
    const secondResult = await handleEducationTask(
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
    const [outbox] = await db.select().from(educationOutbox);
    assertEquals(outbox.processed_at !== null, true);
    assertEquals((await getTaskById(first.id, db))?.status, "succeeded");
});
