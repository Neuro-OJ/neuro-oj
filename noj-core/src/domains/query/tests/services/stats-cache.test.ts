/**
 * stats-cache 服务测试（Handbook §3.4/§3.5）。
 *
 * 口径：
 * - 计数完全由数据库聚合推导（**无进程内计数器**，多副本安全）；
 * - 满分计数读**有效成绩投影**（`is_valid` + 有效尝试分数），不读旧 `evaluation_results`；
 * - `applyNewResult()` 只失效缓存，重复调用不会重复计数；
 * - 缓存键包含全局投影 revision，策略/判定变化后立即换键（不依赖 TTL）。
 *
 * 依赖 PGlite/PG 测试库（resetDbForTest 保证空库起点）。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq, sql } from "drizzle-orm";
import {
  _resetStatsCacheForTest,
  applyNewResult,
  getCachedTodayStats,
  getCachedTotalStats,
} from "../../index.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  problems,
  submissions,
} from "../../../../shared/db/schema.ts";

const now = new Date().toISOString();

/** 建一道题（仅为满足提交外键）。 */
async function seedProblem(id: string, number: number): Promise<void> {
  await getDb().insert(problems).values({
    id,
    title: id,
    description: "d",
    type: "P",
    number,
    owner_id: "0",
    difficulty: "easy",
    created_at: now,
    updated_at: now,
  });
}

/** 建一条提交（有效成绩指针可指向其尝试）。 */
async function seedSubmission(input: {
  id: string;
  problemId: string;
  attemptId: string | null;
  is_valid: boolean;
  is_accepted?: boolean;
  createdAt?: string;
}): Promise<void> {
  await getDb().insert(submissions).values({
    id: input.id,
    user_id: "0",
    problem_id: input.problemId,
    language: "python",
    code: "print(1)",
    version_origin: "legacy_unknown",
    is_valid: input.is_valid,
    is_accepted: input.is_accepted ?? false,
    effective_attempt_id: input.attemptId,
    created_at: input.createdAt ?? now,
  });
}

/** 建一条"提交 + 尝试 + 有效指针"的完整链路（尝试 FK 要求先有提交）。 */
async function seedSubmissionWithAttempt(input: {
  submissionId: string;
  attemptId: string;
  problemId: string;
  score: number;
  is_valid: boolean;
  is_accepted?: boolean;
}): Promise<void> {
  await seedSubmission({
    id: input.submissionId,
    problemId: input.problemId,
    attemptId: null,
    is_valid: input.is_valid,
    is_accepted: input.is_accepted,
  });
  await seedAttempt({
    id: input.attemptId,
    submissionId: input.submissionId,
    problemId: input.problemId,
    score: input.score,
  });
  await getDb().update(submissions).set({
    effective_attempt_id: input.attemptId,
  }).where(eq(submissions.id, input.submissionId));
}

/** 建一条 graded 终态尝试。 */
async function seedAttempt(input: {
  id: string;
  submissionId: string;
  problemId: string;
  score: number;
}): Promise<void> {
  await getDb().insert(evaluationAttempts).values({
    id: input.id,
    submission_id: input.submissionId,
    problem_id: input.problemId,
    sequence: 0,
    source: "initial",
    state: "finished",
    result_kind: "graded",
    result_status: "finished",
    score: input.score,
    accepted: input.score >= 10000,
    created_at: now,
    finished_at: now,
  });
}

/** 推进全局投影 revision（策略切换/判定替换会递增它）。 */
async function bumpGlobalRevision(): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO query_projection_revisions (scope_key, data_revision, materialized_revision)
    VALUES ('global', 1, 0)
    ON CONFLICT (scope_key) DO UPDATE
      SET data_revision = query_projection_revisions.data_revision + 1
  `);
}

Deno.test({
  name: "stats-cache: 空库统计为 0 且重置不抛错",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    _resetStatsCacheForTest();
    applyNewResult();
    const stats = await getCachedTotalStats();
    assertEquals(stats.total, 0);
    assertEquals(stats.full_score, 0);
    assertEquals(stats.not_full_score, 0);
  },
});

Deno.test({
  name: "stats-cache: 计数取自数据库投影，applyNewResult 重复调用不重复计数",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    _resetStatsCacheForTest();
    await seedProblem("sc-p1", 989001);
    // 满分且有效
    await seedSubmissionWithAttempt({
      submissionId: "sc-s1",
      attemptId: "sc-a1",
      problemId: "sc-p1",
      score: 10000,
      is_valid: true,
      is_accepted: true,
    });
    // 非满分但有效
    await seedSubmissionWithAttempt({
      submissionId: "sc-s2",
      attemptId: "sc-a2",
      problemId: "sc-p1",
      score: 5000,
      is_valid: true,
    });
    // 无有效判定：计入提交总数，但不计满分
    await seedSubmission({
      id: "sc-s3",
      problemId: "sc-p1",
      attemptId: null,
      is_valid: false,
    });

    const stats = await getCachedTotalStats();
    assertEquals(stats.total, 3);
    assertEquals(stats.full_score, 1);
    assertEquals(stats.not_full_score, 2);

    // 重复失效缓存不得改变计数（旧实现的内存计数器会在此处重复自增）
    applyNewResult();
    applyNewResult();
    const again = await getCachedTotalStats();
    assertEquals(again.total, 3);
    assertEquals(again.full_score, 1);
  },
});

Deno.test({
  name: "stats-cache: revision 换键后立即读新口径（不依赖 TTL）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    _resetStatsCacheForTest();
    await seedProblem("sc-p2", 989002);
    await seedSubmissionWithAttempt({
      submissionId: "sc-s4",
      attemptId: "sc-a3",
      problemId: "sc-p2",
      score: 10000,
      is_valid: true,
      is_accepted: true,
    });
    assertEquals((await getCachedTotalStats()).full_score, 1);

    // 策略收紧：exact 下该提交不再有效（投影服务会同时清空指针并递增全局 revision）
    await getDb().update(submissions).set({
      is_valid: false,
      is_accepted: false,
      effective_attempt_id: null,
    }).where(eq(submissions.id, "sc-s4"));
    await bumpGlobalRevision();

    const after = await getCachedTotalStats();
    assertEquals(after.total, 1);
    assertEquals(after.full_score, 0);
  },
});

Deno.test({
  name: "stats-cache: 今日统计按提交时间过滤，满分口径同上",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    _resetStatsCacheForTest();
    await seedProblem("sc-p3", 989003);
    await seedSubmissionWithAttempt({
      submissionId: "sc-s5",
      attemptId: "sc-a4",
      problemId: "sc-p3",
      score: 10000,
      is_valid: true,
      is_accepted: true,
    });
    // 昨天的提交：不计入今日
    await seedSubmission({
      id: "sc-s6",
      problemId: "sc-p3",
      attemptId: null,
      is_valid: false,
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    });

    const today = await getCachedTodayStats();
    assertEquals(today.total, 1);
    assertEquals(today.full_score, 1);

    const total = await getCachedTotalStats();
    assertEquals(total.total, 2);
    assertEquals(total.full_score, 1);
  },
});
