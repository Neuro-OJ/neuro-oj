import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq, ne } from "drizzle-orm";
import { fixture, withQueue } from "../_domain-execution-fixture.ts";
import { createDomainSubmission } from "../../index.ts";
import { handleEvaluationDispatchTask } from "../../../application/dispatch-handlers.ts";
import { claimTasks } from "../../../runtime/tasks/repository.ts";
import {
    getRedis,
    resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { ALL_JUDGE_QUEUES } from "../../../../shared/mq/judge-queues.ts";
import { judgeTaskMarkerKey } from "../../mq/task-marker.ts";
import { startFakeRedis as startMarkerAwareFakeRedis } from "../mq/_setup.ts";
import {
    backgroundTasks,
    evaluationAttempts,
    problemVersionObjects,
    storageObjects,
    submissions,
} from "../../../../shared/db/schema.ts";
import {
    LocalStorageProvider,
    resetStorageProvider,
    setStorageProviderForTest,
} from "../../../assets/storage/mod.ts";

async function pendingFixture() {
    const f = await fixture();
    const submission = await createDomainSubmission(
        f.a.slug,
        f.ref,
        f.student,
        {
            version_id: f.v2,
            language: "python3",
            code: "print(1)",
        },
    );
    await f.db.update(submissions).set({ status: "pending" }).where(
        eq(submissions.id, submission.id),
    );
    await f.db.delete(backgroundTasks).where(
        ne(backgroundTasks.target_id, submission.id),
    );
    const [task] = await claimTasks("dispatch-regression", 1, 60_000, f.db);
    assertEquals(task.targetId, submission.id);
    return { ...f, submission, task };
}

Deno.test("dispatch[真实 PG]: 入队与终态/换 attempt 交错时不覆盖提交投影", async () => {
    await withQueue(async () => {
        const f = await pendingFixture();
        const redis = getRedis(), original = redis.eval;
        try {
            redis.eval = async (...args) => {
                const result = await original.apply(redis, args);
                await f.db.update(submissions).set({ status: "finished" })
                    .where(
                        eq(submissions.id, f.submission.id),
                    );
                return result;
            };
            await handleEvaluationDispatchTask(f.task);
            const [row] = await f.db.select().from(submissions).where(
                eq(submissions.id, f.submission.id),
            );
            assertEquals(row.status, "finished");
            redis.eval = async (...args) => {
                const result = await original.apply(redis, args);
                await f.db.update(submissions).set({ active_attempt_id: null })
                    .where(
                        eq(submissions.id, f.submission.id),
                    );
                return result;
            };
            await f.db.update(submissions).set({ status: "pending" }).where(
                eq(submissions.id, f.submission.id),
            );
            await handleEvaluationDispatchTask(f.task);
            const [changed] = await f.db.select().from(submissions).where(
                eq(submissions.id, f.submission.id),
            );
            assertEquals(changed.status, "pending");
            assertEquals(
                (await handleEvaluationDispatchTask(f.task)).skipped,
                "attempt_changed",
            );
        } finally {
            redis.eval = original;
        }
    });
});

Deno.test("dispatch[真实 PG]: 重签下载地址临时失败保留 pending，同一任务随后可派发", async () => {
    await withQueue(async () => {
        const f = await pendingFixture();
        const root = await Deno.makeTempDir({ prefix: "noj-dispatch-fix-" });
        let fail = true;
        class TransientStorage extends LocalStorageProvider {
            override async downloadUrl(url: string, expiresIn?: number) {
                if (fail) throw new Error("temporary_storage_unavailable");
                return await super.downloadUrl(url, expiresIn);
            }
        }
        const storage = new TransientStorage(root);
        setStorageProviderForTest(storage);
        try {
            const url = await storage.put(
                "dispatch-package.zip",
                new TextEncoder().encode("support-package-fixture"),
                "application/zip",
            );
            await f.db.insert(storageObjects).values({
                storage_url: url,
                state: "unknown",
                created_at: new Date().toISOString(),
            });
            await f.db.insert(problemVersionObjects).values({
                version_id: f.v2,
                role: "support_package",
                path: "package.zip",
                storage_url: url,
            });
            await assertRejects(
                () => handleEvaluationDispatchTask(f.task),
                Error,
                "temporary_storage_unavailable",
            );
            const [row] = await f.db.select().from(submissions).where(
                eq(submissions.id, f.submission.id),
            );
            const [attempt] = await f.db.select().from(evaluationAttempts)
                .where(
                    eq(
                        evaluationAttempts.id,
                        f.task.payload.attempt_id as string,
                    ),
                );
            assertEquals(row.status, "pending");
            assertEquals(
                ["error", "finished", "superseded"].includes(attempt.state),
                false,
            );
            // 模拟存储恢复后的事实读取，不重新创建 attempt 或任务。
            fail = false;
            assertEquals(
                (await handleEvaluationDispatchTask(f.task)).dispatched,
                true,
            );
            const [task] = await f.db.select().from(backgroundTasks).where(
                eq(backgroundTasks.id, f.task.id),
            );
            assertEquals(task.payload.attempt_id, f.task.payload.attempt_id);
        } finally {
            resetStorageProvider();
            await Deno.remove(root, { recursive: true });
        }
    });
});

Deno.test("dispatch[真实 PG]: 内联派发已入队时只补齐状态，不重复推送同一 run", async () => {
    const previous = Deno.env.get("REDIS_URL");
    const fake = startMarkerAwareFakeRedis();
    resetRedisForTest();
    Deno.env.set("REDIS_URL", fake.url);
    try {
        await getRedis().connect();
        // pendingFixture 复现的正是崩溃窗口：受理请求已把任务入队并写下 queued
        // 标记，提交状态却仍是 pending。
        const f = await pendingFixture();
        const attemptId = f.task.payload.attempt_id as string;
        const queued = () =>
            ALL_JUDGE_QUEUES.flatMap((queue) => fake.getMessages(queue)).filter(
                (raw) => JSON.parse(raw).run_id === attemptId,
            ).length;
        assertEquals(queued(), 1);
        assertEquals(
            (await handleEvaluationDispatchTask(f.task)).skipped,
            "already_dispatched",
        );
        assertEquals(queued(), 1);
        const [row] = await f.db.select().from(submissions).where(
            eq(submissions.id, f.submission.id),
        );
        assertEquals(row.status, "judging");

        // 另一个副本的恢复器正在派发：本任务让路，不推送也不改状态。
        await f.db.update(submissions).set({ status: "pending" }).where(
            eq(submissions.id, f.submission.id),
        );
        await getRedis().set(judgeTaskMarkerKey(attemptId), "dispatching");
        assertEquals(
            (await handleEvaluationDispatchTask(f.task)).skipped,
            "dispatch_in_progress",
        );
        assertEquals(queued(), 1);
    } finally {
        getRedis().disconnect();
        resetRedisForTest();
        if (previous === undefined) Deno.env.delete("REDIS_URL");
        else Deno.env.set("REDIS_URL", previous);
        await fake.stop();
    }
});
