import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq, ne } from "drizzle-orm";
import { fixture, withQueue } from "../_domain-execution-fixture.ts";
import { createDomainSubmission } from "../../index.ts";
import { handleEvaluationDispatchTask } from "../../../application/dispatch-handlers.ts";
import { claimTasks } from "../../../runtime/tasks/repository.ts";
import { getRedis } from "../../../../shared/mq/connection.ts";
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
  const submission = await createDomainSubmission(f.a.slug, f.ref, f.student, {
    version_id: f.v2,
    language: "python3",
    code: "print(1)",
  });
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
        await f.db.update(submissions).set({ status: "finished" }).where(
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
        await f.db.update(submissions).set({ active_attempt_id: null }).where(
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
      const [attempt] = await f.db.select().from(evaluationAttempts).where(
        eq(evaluationAttempts.id, f.task.payload.attempt_id as string),
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
