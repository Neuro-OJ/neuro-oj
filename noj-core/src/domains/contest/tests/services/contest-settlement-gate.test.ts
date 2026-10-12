/**
 * 竞赛结算门禁回归（Handbook §3.3/§6.6）。
 *
 * 覆盖缺陷：
 * - **#47**：结算完成度必须用 `evaluation_attempts.state` / `result_kind` 判定，
 *   **不得**用 `result_status` 字符串白名单。正式 TLE/CE 等 graded 判定会把具体
 *   verdict 写进该列（`TimeLimitExceeded`/`CE`…），旧实现把它们永久当成"待处理"，
 *   赛事永远无法结算；客观题分支同样要识别平台错误（旧实现硬编码不算失败）。
 * - **#46**：结算门禁必须覆盖**尚未创建尝试**的批任务条目
 *   （`pending` / `preparing` / `dispatched`），否则带在途重测的竞赛可以被发布为
 *   正式成绩，快照与最终成绩不一致。
 */
import { assertExists, assertRejects } from "jsr:@std/assert@^1";
import { eq, inArray } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  problemVersions,
  submissionJobItems,
  submissionJobs,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  getContestRanking,
  getContestSettlementStatus,
  publishContestRankingSnapshot,
} from "../../index.ts";
import { ConflictError } from "../../../../shared/base/errors.ts";
import { insertContestProblems } from "../../../../../tests/helper.ts";

await resetDbForTest({ refreshRankings: true });

const baseTime = Date.now() - 3_600_000;
const atMinutes = (minutes: number) =>
  new Date(baseTime + minutes * 60_000).toISOString();
const now = new Date().toISOString();

async function insertUser(prefix: string): Promise<string> {
  const id = crypto.randomUUID();
  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  await getDb().insert(users).values({
    id,
    username: `${prefix}-${unique}`,
    email: `${prefix}-${unique}@example.com`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function insertProblem(
  id: string,
  number: number,
  objective = false,
): Promise<void> {
  await getDb().insert(problems).values({
    id,
    title: `结算门禁-${number}`,
    description: "d",
    difficulty: "easy",
    runtime_config: null,
    number,
    owner_id: "0",
    type: objective ? "U" : "P",
    is_objective: objective,
    created_at: now,
    updated_at: now,
  });
}

Deno.test({
  name:
    "contest settlement(#47): graded verdict（TLE/CE/用户超时）不算待处理，平台错误与在途尝试归类正确",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const userId = await insertUser("settle-verdict");
    const problemId = crypto.randomUUID();
    const paperId = crypto.randomUUID();
    const contestId = crypto.randomUUID();

    await insertProblem(problemId, 921100);
    await insertProblem(paperId, 921101, true);
    await db.insert(contests).values({
      id: contestId,
      title: "结算分类测试",
      start_time: atMinutes(-120),
      end_time: atMinutes(-1),
      type: "kaggle",
      config: {},
      created_by: userId,
      created_at: now,
      updated_at: now,
    });
    await insertContestProblems([
      {
        contest_id: contestId,
        problem_id: problemId,
        label: "A",
        sort_order: 0,
        score: 10000,
      },
      {
        contest_id: contestId,
        problem_id: paperId,
        label: "B",
        sort_order: 1,
        score: 10000,
      },
    ]);

    const tleId = crypto.randomUUID();
    const ceId = crypto.randomUUID();
    const timeoutId = crypto.randomUUID();
    const runningId = crypto.randomUUID();
    const orphanStateId = crypto.randomUUID();
    const objectiveId = crypto.randomUUID();

    await db.insert(submissions).values([
      {
        id: tleId,
        user_id: userId,
        problem_id: problemId,
        contest_id: contestId,
        language: "python3",
        code: "print(1)",
        status: "finished",
        version_origin: "legacy_unknown",
        created_at: atMinutes(-50),
      },
      {
        id: ceId,
        user_id: userId,
        problem_id: problemId,
        contest_id: contestId,
        language: "python3",
        code: "print(2)",
        status: "finished",
        version_origin: "legacy_unknown",
        created_at: atMinutes(-45),
      },
      {
        id: timeoutId,
        user_id: userId,
        problem_id: problemId,
        contest_id: contestId,
        language: "python3",
        code: "print(3)",
        status: "finished",
        version_origin: "legacy_unknown",
        created_at: atMinutes(-40),
      },
      {
        id: runningId,
        user_id: userId,
        problem_id: problemId,
        contest_id: contestId,
        language: "python3",
        code: "print(4)",
        status: "pending",
        version_origin: "legacy_unknown",
        created_at: atMinutes(-35),
      },
      {
        id: orphanStateId,
        user_id: userId,
        problem_id: problemId,
        contest_id: contestId,
        language: "python3",
        code: "print(5)",
        status: "finished",
        version_origin: "legacy_unknown",
        created_at: atMinutes(-34),
      },
    ]);

    const attempts = [
      {
        id: crypto.randomUUID(),
        submissionId: tleId,
        status: "TimeLimitExceeded",
      },
      { id: crypto.randomUUID(), submissionId: ceId, status: "CE" },
      {
        id: crypto.randomUUID(),
        submissionId: timeoutId,
        status: "TimeLimitExceeded",
      },
    ];
    for (const attempt of attempts) {
      await db.insert(evaluationAttempts).values({
        id: attempt.id,
        submission_id: attempt.submissionId,
        problem_id: problemId,
        sequence: 0,
        source: "initial",
        state: "finished",
        result_kind: "graded",
        result_status: attempt.status,
        score: 0,
        accepted: false,
        created_at: atMinutes(-30),
        finished_at: atMinutes(-30),
      });
    }

    // 在途重测：active 指向 queued 尝试（旧有效尝试仍留着），提交状态 pending
    const runningActiveAttempt = crypto.randomUUID();
    const runningOldAttempt = crypto.randomUUID();
    await db.insert(evaluationAttempts).values([
      {
        id: runningOldAttempt,
        submission_id: runningId,
        problem_id: problemId,
        sequence: 0,
        source: "initial",
        state: "finished",
        result_kind: "graded",
        result_status: "finished",
        score: 10000,
        accepted: true,
        created_at: atMinutes(-33),
        finished_at: atMinutes(-33),
      },
      {
        id: runningActiveAttempt,
        submission_id: runningId,
        problem_id: problemId,
        sequence: 1,
        source: "rejudge",
        state: "queued",
        created_at: atMinutes(-32),
      },
      // 防御分支：提交级状态已终结但尝试仍在途，也必须算待处理
      {
        id: crypto.randomUUID(),
        submission_id: orphanStateId,
        problem_id: problemId,
        sequence: 0,
        source: "rejudge",
        state: "judging",
        created_at: atMinutes(-31),
      },
    ]);
    await db.update(submissions).set({
      active_attempt_id: runningActiveAttempt,
      latest_attempt_id: runningOldAttempt,
      effective_attempt_id: runningOldAttempt,
      is_valid: true,
      is_accepted: true,
    }).where(eq(submissions.id, runningId));
    for (const attempt of attempts) {
      await db.update(submissions).set({
        latest_attempt_id: attempt.id,
        effective_attempt_id: attempt.id,
      }).where(eq(submissions.id, attempt.submissionId));
    }

    // 客观题平台错误：旧实现把客观题分支的 platform_error 固定为 false
    await db.insert(objectiveSubmissions).values({
      id: objectiveId,
      paper_id: paperId,
      user_id: userId,
      contest_id: contestId,
      submission_type: "contest",
      answers: {},
      status: "error",
      score: 0,
      details: {},
      created_at: atMinutes(-20),
    });
    const objectiveAttempt = crypto.randomUUID();
    await db.insert(evaluationAttempts).values({
      id: objectiveAttempt,
      objective_submission_id: objectiveId,
      problem_id: paperId,
      sequence: 0,
      source: "initial",
      state: "error",
      result_kind: "platform_error",
      result_status: "error",
      created_at: atMinutes(-19),
    });
    await db.update(objectiveSubmissions).set({
      latest_attempt_id: objectiveAttempt,
      effective_attempt_id: objectiveAttempt,
    }).where(eq(objectiveSubmissions.id, objectiveId));

    try {
      const readiness = await getContestSettlementStatus(contestId);
      // 只有 running / orphanState 两条是待处理；TLE/CE/用户超时都是已完成正式判定
      if (readiness.pending_count !== 2) {
        throw new Error(
          `pending_count 期望 2，实际 ${readiness.pending_count}；items=${
            readiness.items.map((item) =>
              `${item.submission_id}:${item.status}`
            )
          }`,
        );
      }
      if (readiness.failed_count !== 1) {
        throw new Error(
          `failed_count 期望 1，实际 ${readiness.failed_count}；items=${
            readiness.items.map((item) =>
              `${item.submission_id}:${item.status}`
            )
          }`,
        );
      }
      const itemIds = readiness.items.map((item) => item.submission_id).sort();
      if (
        JSON.stringify(itemIds) !==
          JSON.stringify([runningId, orphanStateId, objectiveId].sort())
      ) {
        throw new Error(`明细集合不符：${JSON.stringify(itemIds)}`);
      }
      // 已完成的 graded verdict 必须完全不在门禁明细里
      for (const id of [tleId, ceId, timeoutId]) {
        if (itemIds.includes(id)) {
          throw new Error(`graded 提交被误判为门禁项：${id}`);
        }
      }

      // 结算发布同样被门禁拒绝（未终结任务存在）
      await assertRejects(
        () => publishContestRankingSnapshot(contestId, userId),
        ConflictError,
      );
    } finally {
      await db.delete(evaluationAttempts).where(
        inArray(evaluationAttempts.problem_id, [problemId, paperId]),
      );
      await db.delete(submissions).where(eq(submissions.contest_id, contestId));
      await db.delete(objectiveSubmissions).where(
        eq(objectiveSubmissions.contest_id, contestId),
      );
      await db.delete(contestProblems).where(
        eq(contestProblems.contest_id, contestId),
      );
      await db.delete(contests).where(eq(contests.id, contestId));
      // 先断开 problems.latest_version_id 指针再删版本行（否则外键阻止删除）
      await db.update(problems).set({ latest_version_id: null }).where(
        inArray(problems.id, [problemId, paperId]),
      );
      await db.delete(problemVersions).where(
        inArray(problemVersions.problem_id, [problemId, paperId]),
      );
      await db.delete(problems).where(
        inArray(problems.id, [problemId, paperId]),
      );
      await db.delete(users).where(eq(users.id, userId));
    }
  },
});

Deno.test({
  name:
    "contest settlement(#46): 尚未创建尝试的批任务条目（pending/preparing/dispatched）阻止正式成绩发布",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const adminId = await insertUser("settle-job-admin");
    const userId = await insertUser("settle-job-user");
    const problemId = crypto.randomUUID();
    const contestId = crypto.randomUUID();
    const submissionId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const itemId = crypto.randomUUID();

    await insertProblem(problemId, 921110);
    await db.insert(contests).values({
      id: contestId,
      title: "批任务门禁测试",
      start_time: atMinutes(-120),
      end_time: atMinutes(-1),
      type: "kaggle",
      config: {},
      created_by: adminId,
      created_at: now,
      updated_at: now,
    });
    await insertContestProblems({
      contest_id: contestId,
      problem_id: problemId,
      label: "A",
      sort_order: 0,
      score: 10000,
    });
    await db.insert(contestParticipants).values({
      contest_id: contestId,
      user_id: userId,
      registered_at: atMinutes(-100),
    });
    await db.insert(submissions).values({
      id: submissionId,
      user_id: userId,
      problem_id: problemId,
      contest_id: contestId,
      language: "python3",
      code: "print(1)",
      status: "finished",
      version_origin: "legacy_unknown",
      created_at: atMinutes(-50),
    });
    await db.insert(evaluationAttempts).values({
      id: attemptId,
      submission_id: submissionId,
      problem_id: problemId,
      sequence: 0,
      source: "initial",
      state: "finished",
      result_kind: "graded",
      result_status: "finished",
      score: 10000,
      accepted: true,
      created_at: atMinutes(-49),
      finished_at: atMinutes(-49),
    });
    await db.update(submissions).set({
      is_contest_valid: true,
      latest_attempt_id: attemptId,
      effective_attempt_id: attemptId,
      contest_effective_attempt_id: attemptId,
    }).where(eq(submissions.id, submissionId));

    await db.insert(submissionJobs).values({
      id: jobId,
      kind: "rejudge",
      actor_id: adminId,
      idempotency_key: `settle-gate-${Date.now()}`,
      request_hash: "hash",
      request: {},
      status: "queued",
      created_at: now,
    });
    // 条目在受理事务里就已落库（此刻还没有 attempt_id）
    await db.insert(submissionJobItems).values({
      id: itemId,
      job_id: jobId,
      ordinal: 0,
      source_kind: "submission",
      source_id: submissionId,
      problem_id: problemId,
      status: "pending",
      created_at: now,
    });

    try {
      // 提交本身已判定完成：相机能发布；但条目未终态时不得发布
      const baseline = await getContestSettlementStatus(contestId);
      assertExists(baseline);
      if (baseline.pending_count < 1) {
        throw new Error(`未终态条目未计入待处理：${baseline.pending_count}`);
      }
      await assertRejects(
        () => publishContestRankingSnapshot(contestId, adminId),
        ConflictError,
      );

      for (
        const status of ["preparing", "dispatched"] as const
      ) {
        await db.update(submissionJobItems).set({ status }).where(
          eq(submissionJobItems.id, itemId),
        );
        const readiness = await getContestSettlementStatus(contestId);
        if (readiness.pending_count < 1) {
          throw new Error(`状态 ${status} 未计入待处理`);
        }
        await assertRejects(
          () => publishContestRankingSnapshot(contestId, adminId),
          ConflictError,
        );
      }

      // 条目终态（成功）后门禁放行
      await db.update(submissionJobItems).set({
        status: "succeeded",
        attempt_id: attemptId,
        finished_at: now,
      }).where(eq(submissionJobItems.id, itemId));
      const cleared = await getContestSettlementStatus(contestId);
      if (cleared.pending_count !== 0 || cleared.failed_count !== 0) {
        throw new Error(
          `终态条目未清空门禁：pending=${cleared.pending_count}, failed=${cleared.failed_count}`,
        );
      }
      const snapshot = await publishContestRankingSnapshot(
        contestId,
        adminId,
      );
      if (snapshot.version !== 1) {
        throw new Error(`快照版本期望 1，实际 ${snapshot.version}`);
      }
      const ranking = await getContestRanking(contestId, "kaggle");
      if (ranking[0]?.total_score !== 10000) {
        throw new Error(`快照成绩不符：${ranking[0]?.total_score}`);
      }
    } finally {
      await db.delete(submissionJobItems).where(
        eq(submissionJobItems.id, itemId),
      );
      await db.delete(submissionJobs).where(eq(submissionJobs.id, jobId));
      await db.delete(evaluationAttempts).where(
        eq(evaluationAttempts.problem_id, problemId),
      );
      await db.delete(submissions).where(eq(submissions.id, submissionId));
      await db.delete(contestParticipants).where(
        eq(contestParticipants.contest_id, contestId),
      );
      await db.delete(contestProblems).where(
        eq(contestProblems.contest_id, contestId),
      );
      await db.delete(contests).where(eq(contests.id, contestId));
      await db.update(problems).set({ latest_version_id: null }).where(
        eq(problems.id, problemId),
      );
      await db.delete(problemVersions).where(
        eq(problemVersions.problem_id, problemId),
      );
      await db.delete(problems).where(eq(problems.id, problemId));
      await db.delete(users).where(inArray(users.id, [adminId, userId]));
    }
  },
});
