/**
 * 真实 PostgreSQL 并发/锁协议验证（tracking #12、#30）。
 *
 * PGlite 是单连接内存库，无法验证行锁排队与互斥，因此这些用例只在设置了
 * `DATABASE_URL` 时运行（`ignore: !HAS_PG`）。本文件关闭 preload 事务包装
 * （并发用例必须各自持锁），所有夹具在用例结束时显式清理。
 *
 * 验证的协议（Handbook §2.5、§5.1）：
 * 1. **存储删除守卫**：登记行锁、引用检查与物理删除在同一事务内完成，
 *    "检查无引用 → 新引用建立 → 对象被删"的窗口不存在；
 * 2. **锁顺序 题目 → 竞赛 → 提交 → 尝试 → revision**：结果写入对题目取共享锁、
 *    策略切换对策略宿主取更新锁，二者互斥，后到的策略重算不会用旧候选覆盖新投影。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import {
  disableTestTransactionForFile,
  getDb,
} from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  evaluationAttempts,
  problems,
  problemVersions,
  storageObjects,
  submissions,
  submissionVersionResults,
} from "../../../../shared/db/schema.ts";
import {
  assertStorageObjectBindable,
  deleteStorageObject,
  registerReadyStorageObject,
} from "../../../system/services/storage/registry.ts";
import {
  getStorageProvider,
  setStorageProviderForTest,
} from "../../../system/services/storage/factory.ts";
import { LocalStorageProvider } from "../../../system/services/storage/local.ts";
import { applyAttemptResult } from "../../services/versioning/result-write.ts";
import { setProblemEffectiveVersionPolicy } from "../../services/versioning/effective-policy.ts";

const HAS_PG = !!Deno.env.get("DATABASE_URL");
if (HAS_PG) disableTestTransactionForFile();

const tempStorageDir = Deno.makeTempDirSync({ prefix: "noj-lock-order-" });
setStorageProviderForTest(new LocalStorageProvider(tempStorageDir));

const db = getDb();
const now = new Date().toISOString();

/** 独立连接上的 drizzle 句柄：用于制造真实的行锁竞争。 */
async function withRawDb<T>(
  fn: (raw: Executor, client: postgres.Sql) => Promise<T>,
): Promise<T> {
  const client = postgres(Deno.env.get("DATABASE_URL")!, { max: 1 });
  try {
    return await fn(drizzlePg(client) as unknown as Executor, client);
  } finally {
    await client.end();
  }
}

/** 极短等待；仅用于让被阻塞的事务进入 PostgreSQL 锁队列。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedProblem(id: string, number: number): Promise<string> {
  const versionId = `${id}-v1`;
  await db.insert(problems).values({
    id,
    title: id,
    description: "d",
    type: "P",
    number,
    owner_id: "0",
    difficulty: "easy",
    judge_type: "dual",
    created_at: now,
    updated_at: now,
  });
  await db.insert(problemVersions).values({
    id: versionId,
    problem_id: id,
    version: 1,
    origin: "published",
    content: { kind: "ai", title: id, description: "d", samples: [] },
    published_at: now,
  });
  await db.update(problems).set({ latest_version_id: versionId }).where(
    eq(problems.id, id),
  );
  return versionId;
}

async function cleanupProblem(id: string): Promise<void> {
  await db.delete(submissionVersionResults).where(
    eq(submissionVersionResults.problem_id, id),
  );
  await db.delete(evaluationAttempts).where(
    eq(evaluationAttempts.problem_id, id),
  );
  await db.delete(submissions).where(eq(submissions.problem_id, id));
  await db.update(problems).set({
    latest_version_id: null,
    // 策略可能已被切换为 exact(X)：先解开对版本的外键引用再删版本
    required_version_id: null,
    effective_version_mode: "any",
  }).where(eq(problems.id, id));
  await db.delete(problemVersions).where(eq(problemVersions.problem_id, id));
  await db.delete(problems).where(eq(problems.id, id));
}

/**
 * 本文件关闭了 preload 事务包装，失败中断可能留下夹具；按题号自愈清理，
 * 保证重复运行/失败重跑不会因唯一约束或残留状态而误报。
 */
async function cleanupByNumber(number: number): Promise<void> {
  const rows = await db.select({ id: problems.id }).from(problems).where(
    eq(problems.number, number),
  );
  for (const row of rows) await cleanupProblem(row.id);
}

Deno.test({
  name: "pg lock: 删除与绑定互斥——已删对象不可能被新引用绑定（#12）",
  ignore: !HAS_PG,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const provider = await getStorageProvider();
    const url = await provider.put(
      `locks/${crypto.randomUUID()}`,
      new TextEncoder().encode("lock-guard"),
    );
    await registerReadyStorageObject({
      storageUrl: url,
      sha256: "h",
      byteSize: 10,
    });
    const problemId = `pg-lock-p1-${crypto.randomUUID().slice(0, 8)}`;
    await cleanupByNumber(986001);
    const versionId = await seedProblem(problemId, 986001);

    // A：显式持有登记行锁，让"删除"与"绑定"都停在锁外并进入 FIFO 队列
    const barrier = postgres(Deno.env.get("DATABASE_URL")!, { max: 1 });
    await barrier`BEGIN`;
    await barrier`SELECT storage_url FROM storage_objects WHERE storage_url = ${url} FOR UPDATE`;

    let deleteSettled = false;
    let bindSettled = false;
    const deletePromise = withRawDb(async (tx) => {
      const outcome = await deleteStorageObject(url, tx);
      deleteSettled = true;
      return outcome;
    });
    await sleep(150);
    // B：模拟真实绑定路径（断言可绑定 + 同一事务插入引用）
    const bindPromise = withRawDb(async (tx) => {
      await assertStorageObjectBindable(url, tx);
      await tx.insert(submissions).values({
        id: `pg-lock-bind-${crypto.randomUUID()}`,
        user_id: "0",
        problem_id: problemId,
        language: "python3",
        code: "",
        artifact_storage_url: url,
        submitted_version_id: versionId,
        version_origin: "known",
        status: "pending",
        created_at: now,
      });
      bindSettled = true;
      return "bound";
    });

    await sleep(250);
    // 锁被 A 持有：删除与绑定都必须阻塞（证明二者争用同一登记行锁）
    assertEquals(deleteSettled, false);
    assertEquals(bindSettled, false);

    await barrier`COMMIT`;
    await barrier.end();

    const deleteOutcome = await deletePromise;
    assertEquals(deleteOutcome.outcome, "deleted");
    // 排队在后的绑定必须失败：对象已 deleted，不能建立新引用
    await assertRejects(() => bindPromise, Error, "不能建立新引用");

    // 物理对象已删除，且没有任何提交引用它
    assertEquals((await provider.stat(url)).exists, false);
    assertEquals(
      (await db.select().from(submissions).where(
        eq(submissions.artifact_storage_url, url),
      )).length,
      0,
    );
    await db.delete(storageObjects).where(
      eq(storageObjects.storage_url, url),
    );
    await cleanupProblem(problemId);
  },
});

Deno.test({
  name: "pg lock: 策略切换与结果写入互斥且不丢更新（#30）",
  ignore: !HAS_PG,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problemId = `pg-lock-p2-${crypto.randomUUID().slice(0, 8)}`;
    await cleanupByNumber(986002);
    const versionId = await seedProblem(problemId, 986002);
    const submissionId = `pg-lock-sub-${crypto.randomUUID()}`;
    const attemptId = `pg-lock-att-${crypto.randomUUID()}`;
    await db.insert(submissions).values({
      id: submissionId,
      user_id: "0",
      problem_id: problemId,
      language: "python3",
      code: "print(1)",
      submitted_version_id: versionId,
      version_origin: "known",
      status: "pending",
      judge_run_id: attemptId,
      rejudge_seq: 0,
      created_at: now,
    });
    await db.insert(evaluationAttempts).values({
      id: attemptId,
      submission_id: submissionId,
      problem_id: problemId,
      problem_version_id: versionId,
      sequence: 0,
      source: "initial",
      state: "judging",
      created_at: now,
    });
    await db.update(submissions).set({ active_attempt_id: attemptId }).where(
      eq(submissions.id, submissionId),
    );

    // A：持有题目行更新锁（模拟"策略宿主正被修改"）
    const barrier = postgres(Deno.env.get("DATABASE_URL")!, { max: 1 });
    await barrier`BEGIN`;
    await barrier`SELECT id FROM problems WHERE id = ${problemId} FOR UPDATE`;

    let resultSettled = false;
    let policySettled = false;
    // B：结果写入（对题目取共享锁 → 必须等待 A）
    const resultPromise = withRawDb(async (tx) => {
      const outcome = await applyAttemptResult({
        attemptId,
        resultKind: "graded",
        resultStatus: "finished",
        score: 10000,
        accepted: true,
        output: "AC",
        details: {},
      }, tx);
      resultSettled = true;
      return outcome;
    });
    await sleep(200);
    // C：策略切换（对策略宿主取更新锁 → 排在 B 之后）
    const policyPromise = withRawDb(async (tx) => {
      const result = await tx.transaction((inner) =>
        setProblemEffectiveVersionPolicy(problemId, {
          policy: { mode: "exact", version_id: versionId },
          expectedRevision: 0,
        }, inner as unknown as Executor)
      );
      policySettled = true;
      return result;
    });

    await sleep(300);
    assertEquals(resultSettled, false, "结果写入必须等待题目宿主锁");
    assertEquals(policySettled, false, "策略切换必须等待结果写入完成");

    await barrier`COMMIT`;
    await barrier.end();

    const applied = await resultPromise;
    const policy = await policyPromise;
    assertEquals(applied.applied, "graded");
    assertEquals(policy.revision, 1);

    // 结果先落库，策略随后重算：exact(V1) + V1 的 AC 必须同时可见（无丢更新）
    const [row] = await db.select().from(submissions).where(
      eq(submissions.id, submissionId),
    );
    assertEquals(row.status, "finished");
    assertEquals(row.active_attempt_id, null);
    assertEquals(row.is_valid, true);
    assertEquals(row.is_accepted, true);
    assertEquals(row.effective_attempt_id, attemptId);
    // 策略 revision 写在提交行上，证明策略重算发生在结果写入之后
    assertEquals(row.global_policy_revision, 1);
    assertEquals(
      (await db.select().from(submissionVersionResults).where(
        eq(submissionVersionResults.submission_id, submissionId),
      )).length,
      1,
    );
    await cleanupProblem(problemId);
  },
});
