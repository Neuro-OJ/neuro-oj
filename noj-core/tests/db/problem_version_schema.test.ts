/**
 * 题目版本管理基础模型的数据库约束测试（Handbook §2）。
 *
 * 覆盖那些**只有真实约束才能保证**的不变量：复合外键（P12 的提交不能引用 P13 的
 * 版本）、已发布版本不可修改守卫、`known`/`legacy_unknown` 与版本列的一致性、
 * 分版本当前判定的 partial unique index、尝试的「恰好一个来源」约束。
 *
 * preload 会把每个用例包在事务里回滚；预期失败的写入放在 `db.transaction()`
 * 中执行（测试内事务被转换成 SAVEPOINT），避免错误中断外层事务。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../src/shared/db/connection.ts";
import {
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  problemVersions,
  queryProjectionRevisions,
  submissions,
  submissionVersionResults,
} from "../../src/shared/db/schema.ts";

const now = new Date().toISOString();

/** 插入一道题 + 一个版本，返回版本 ID。 */
async function seedProblemWithVersion(
  problemId: string,
  versionId: string,
  number: number,
): Promise<void> {
  const db = getDb();
  await db.insert(problems).values({
    id: problemId,
    title: problemId,
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
    problem_id: problemId,
    version: 1,
    schema_version: 1,
    origin: "migration_baseline",
    content: { title: problemId },
    published_at: now,
  });
}

Deno.test("problem versions: 复合外键阻止提交引用他题版本", async () => {
  const db = getDb();
  await seedProblemWithVersion("pv-p12", "pv-v12", 900001);
  await seedProblemWithVersion("pv-p13", "pv-v13", 900002);

  // 正确引用可以写入
  await db.insert(submissions).values({
    id: "pv-sub-ok",
    user_id: "0",
    problem_id: "pv-p12",
    language: "python",
    code: "print(1)",
    submitted_version_id: "pv-v12",
    version_origin: "known",
    created_at: now,
  });

  // 跨题引用必须失败（P12 的提交不能引用 P13 的版本）
  await assertRejects(() =>
    getDb().transaction(async (tx) => {
      await tx.insert(submissions).values({
        id: "pv-sub-cross",
        user_id: "0",
        problem_id: "pv-p12",
        language: "python",
        code: "print(1)",
        submitted_version_id: "pv-v13",
        version_origin: "known",
        created_at: now,
      });
    })
  );
});

Deno.test("problem versions: 已发布版本不可修改（UPDATE 守卫）", async () => {
  const db = getDb();
  await seedProblemWithVersion("pv-immutable", "pv-immutable-v1", 900003);

  await assertRejects(() =>
    getDb().transaction(async (tx) => {
      await tx.update(problemVersions)
        .set({ content: { title: "tampered" } })
        .where(eq(problemVersions.id, "pv-immutable-v1"));
    })
  );

  // 内容未被改动
  const [row] = await db.select().from(problemVersions).where(
    eq(problemVersions.id, "pv-immutable-v1"),
  );
  assertEquals((row.content as { title: string }).title, "pv-immutable");
});

Deno.test("problem versions: 迁移基线允许补 content_sha256，普通发布不允许", async () => {
  const db = getDb();
  await seedProblemWithVersion("pv-hash", "pv-hash-v1", 900004);
  // 基线 NULL → 哈希：允许（存量回填路径）
  await db.update(problemVersions)
    .set({ content_sha256: "abc123" })
    .where(eq(problemVersions.id, "pv-hash-v1"));
  const [row] = await db.select().from(problemVersions).where(
    eq(problemVersions.id, "pv-hash-v1"),
  );
  assertEquals(row.content_sha256, "abc123");
  // 已填写的哈希不允许再改
  await assertRejects(() =>
    getDb().transaction(async (tx) => {
      await tx.update(problemVersions)
        .set({ content_sha256: "def456" })
        .where(eq(problemVersions.id, "pv-hash-v1"));
    })
  );
});

Deno.test("problem versions: 策略列与要求版本必须一致", async () => {
  const db = getDb();
  await seedProblemWithVersion("pv-policy", "pv-policy-v1", 900005);
  // exact 无要求版本 → CHECK 拒绝
  await assertRejects(() =>
    getDb().transaction(async (tx) => {
      await tx.update(problems)
        .set({ effective_version_mode: "exact" })
        .where(eq(problems.id, "pv-policy"));
    })
  );
  // exact + 要求版本 → 允许
  await db.update(problems)
    .set({
      effective_version_mode: "exact",
      required_version_id: "pv-policy-v1",
      effective_policy_revision: 1,
    })
    .where(eq(problems.id, "pv-policy"));
  // any + 残留要求版本 → CHECK 拒绝
  await assertRejects(() =>
    getDb().transaction(async (tx) => {
      await tx.update(problems)
        .set({ effective_version_mode: "any" })
        .where(eq(problems.id, "pv-policy"));
    })
  );
});

Deno.test("submissions: known 必须有版本，legacy_unknown 必须为空", async () => {
  await seedProblemWithVersion("pv-origin", "pv-origin-v1", 900006);
  // known 但无版本 → 拒绝
  await assertRejects(() =>
    getDb().transaction(async (tx) => {
      await tx.insert(submissions).values({
        id: "pv-origin-bad",
        user_id: "0",
        problem_id: "pv-origin",
        language: "python",
        code: "x",
        version_origin: "known",
        created_at: now,
      });
    })
  );
  // legacy_unknown 但带版本 → 拒绝
  await assertRejects(() =>
    getDb().transaction(async (tx) => {
      await tx.insert(submissions).values({
        id: "pv-origin-bad2",
        user_id: "0",
        problem_id: "pv-origin",
        language: "python",
        code: "x",
        version_origin: "legacy_unknown",
        submitted_version_id: "pv-origin-v1",
        created_at: now,
      });
    })
  );
});

Deno.test("evaluation attempts: 两个来源恰好一个非空", async () => {
  const db = getDb();
  await seedProblemWithVersion("pv-attempt", "pv-attempt-v1", 900007);
  await db.insert(submissions).values({
    id: "pv-attempt-sub",
    user_id: "0",
    problem_id: "pv-attempt",
    language: "python",
    code: "x",
    submitted_version_id: "pv-attempt-v1",
    version_origin: "known",
    created_at: now,
  });

  // 两个都为空 → 拒绝
  await assertRejects(() =>
    getDb().transaction(async (tx) => {
      await tx.insert(evaluationAttempts).values({
        id: "pv-attempt-none",
        problem_id: "pv-attempt",
        problem_version_id: "pv-attempt-v1",
        sequence: 0,
        source: "initial",
        created_at: now,
      });
    })
  );
  // 两个都非空 → 拒绝
  await assertRejects(() =>
    getDb().transaction(async (tx) => {
      await tx.insert(evaluationAttempts).values({
        id: "pv-attempt-both",
        submission_id: "pv-attempt-sub",
        objective_submission_id: "pv-obj-does-not-exist",
        problem_id: "pv-attempt",
        sequence: 0,
        source: "initial",
        created_at: now,
      });
    })
  );
});

Deno.test("submission version results: 已知版本与未知版本各一个桶", async () => {
  const db = getDb();
  await seedProblemWithVersion("pv-svr", "pv-svr-v1", 900008);
  await db.insert(submissions).values({
    id: "pv-svr-sub",
    user_id: "0",
    problem_id: "pv-svr",
    language: "python",
    code: "x",
    submitted_version_id: "pv-svr-v1",
    version_origin: "known",
    created_at: now,
  });
  await db.insert(evaluationAttempts).values([
    {
      id: "pv-svr-a1",
      submission_id: "pv-svr-sub",
      problem_id: "pv-svr",
      problem_version_id: "pv-svr-v1",
      sequence: 0,
      source: "initial",
      state: "finished",
      result_kind: "graded",
      created_at: now,
    },
    {
      id: "pv-svr-a2",
      submission_id: "pv-svr-sub",
      problem_id: "pv-svr",
      problem_version_id: null,
      sequence: 1,
      source: "legacy_import",
      state: "finished",
      result_kind: "graded",
      created_at: now,
    },
  ]);
  await db.insert(submissionVersionResults).values([
    {
      id: "pv-svr-r1",
      submission_id: "pv-svr-sub",
      problem_id: "pv-svr",
      problem_version_id: "pv-svr-v1",
      current_attempt_id: "pv-svr-a1",
      updated_at: now,
    },
    {
      id: "pv-svr-r2",
      submission_id: "pv-svr-sub",
      problem_id: "pv-svr",
      problem_version_id: null,
      current_attempt_id: "pv-svr-a2",
      updated_at: now,
    },
  ]);

  // 已知版本桶重复 → 拒绝
  await assertRejects(() =>
    getDb().transaction(async (tx) => {
      await tx.insert(submissionVersionResults).values({
        id: "pv-svr-r3",
        submission_id: "pv-svr-sub",
        problem_id: "pv-svr",
        problem_version_id: "pv-svr-v1",
        current_attempt_id: "pv-svr-a1",
        updated_at: now,
      });
    })
  );
  // 未知版本桶重复 → 拒绝
  await assertRejects(() =>
    getDb().transaction(async (tx) => {
      await tx.insert(submissionVersionResults).values({
        id: "pv-svr-r4",
        submission_id: "pv-svr-sub",
        problem_id: "pv-svr",
        problem_version_id: null,
        current_attempt_id: "pv-svr-a2",
        updated_at: now,
      });
    })
  );

  const rows = await db.select().from(submissionVersionResults).where(
    and(eq(submissionVersionResults.submission_id, "pv-svr-sub")),
  );
  assertEquals(rows.length, 2);
});

Deno.test("objective submissions: 版本字段与重判序列号已就位", async () => {
  const db = getDb();
  await seedProblemWithVersion("pv-obj-paper", "pv-obj-v1", 900009);
  await db.update(problems)
    .set({ is_objective: true, judge_type: "dual" })
    .where(eq(problems.id, "pv-obj-paper"));
  await db.insert(objectiveSubmissions).values({
    id: "pv-obj-sub",
    paper_id: "pv-obj-paper",
    user_id: "0",
    submission_type: "practice",
    answers: {},
    status: "finished",
    score: 0,
    details: {},
    submitted_version_id: "pv-obj-v1",
    version_origin: "known",
    created_at: now,
  });
  const [row] = await db.select().from(objectiveSubmissions).where(
    eq(objectiveSubmissions.id, "pv-obj-sub"),
  );
  assertEquals(row.rejudge_seq, 0);
  assertEquals(row.is_valid, false);
  assertEquals(row.is_contest_valid, false);
  assert(row.submitted_version_id === "pv-obj-v1");

  // 换题目的版本 → 复合外键拒绝
  await seedProblemWithVersion("pv-obj-other", "pv-obj-other-v1", 900010);
  await assertRejects(() =>
    getDb().transaction(async (tx) => {
      await tx.update(objectiveSubmissions)
        .set({ submitted_version_id: "pv-obj-other-v1" })
        .where(eq(objectiveSubmissions.id, "pv-obj-sub"));
    })
  );
});

Deno.test("query projection revisions: 物化 revision 不得超过数据 revision", async () => {
  const db = getDb();
  await db.insert(queryProjectionRevisions).values({
    scope_key: "problem:pv-qpr",
    data_revision: 3,
    materialized_revision: 2,
  });
  await assertRejects(() =>
    getDb().transaction(async (tx) => {
      await tx.update(queryProjectionRevisions)
        .set({ materialized_revision: 4 })
        .where(eq(queryProjectionRevisions.scope_key, "problem:pv-qpr"));
    })
  );
});
