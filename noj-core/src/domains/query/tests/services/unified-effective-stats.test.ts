import {
  deleteProblemFixtures,
  problemExecutionForTest,
  publishBaselineVersionForTest,
} from "../../../../../tests/helper.ts";
/**
 * 全站读取口径统一回归（Handbook §3.4/§3.5）。
 *
 * 覆盖缺陷：
 * - **#50**：统计不得因运行状态（重测置 `pending`、平台错误置 `error`）而使
 *   **已有有效成绩消失**；有效口径以投影（`is_valid` / `is_accepted`）与有效尝试为准。
 * - **#51**：客观题必须纳入个人资料 / 全局排行 / 通过门槛的统一聚合（按题目 ID 去重）。
 * - **#52**：实际提交数（total）与当前口径有效数（valid）分离，公开通过率分母为
 *   valid；仪表盘不再把"有最近尝试"当作已判定。
 *
 * 文件位置说明：`problems-stats.ts` / `dashboard.ts` 属本 workstream，但
 * `catalog/tests/**` 的写作用域归 catalog workstream，故这些跨服务口径断言放在
 * query 域测试目录（测试文件不受域边界门禁约束）。
 */
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { getGlobalRankings } from "../../index.ts";
import {
  getProblemStatsDetail,
  getPublicProblemStats,
} from "../../../catalog/index.ts";
import { getDashboardStats } from "../../services/dashboard.ts";
import type { SubmissionStatus } from "../../../submission/types/index.ts";
import type {
  AttemptResultKind,
  AttemptState,
} from "../../../../shared/versioning/types.ts";

await resetDbForTest({ refreshRankings: true });

const now = new Date().toISOString();
const FULL_SCORE = 10000;

async function seedUser(prefix: string): Promise<string> {
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

async function seedProblem(
  number: number,
  objective = false,
): Promise<string> {
  const id = crypto.randomUUID();
  await getDb().insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id,
    title: `口径统一-${number}`,
    description: "d",
    difficulty: "easy",
    runtime_config: null,
    number,
    owner_id: "0",
    is_objective: objective,
    created_at: now,
    updated_at: now,
  });
  await publishBaselineVersionForTest(id);
  return id;
}

/** 插入代码提交 + 尝试，并按参数写入投影与运行状态。 */
async function seedCodeSubmission(
  problemId: string,
  userId: string,
  options: {
    score: number;
    accepted: boolean;
    valid: boolean;
    submissionStatus?: SubmissionStatus;
    attemptState?: AttemptState;
    resultKind?: AttemptResultKind | null;
    resultStatus?: string | null;
    active?: boolean;
  },
): Promise<{ submissionId: string; attemptId: string }> {
  const submissionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await getDb().insert(submissions).values({
    id: submissionId,
    user_id: userId,
    problem_id: problemId,
    ...await problemExecutionForTest(problemId),
    language: "python3",
    code: "print(1)",
    status: options.submissionStatus ?? "finished",
    created_at: now,
  });
  await getDb().insert(evaluationAttempts).values({
    id: attemptId,
    submission_id: submissionId,
    problem_id: problemId,
    sequence: 0,
    source: "initial",
    state: options.attemptState ?? "finished",
    result_kind: options.resultKind === undefined
      ? "graded"
      : options.resultKind,
    result_status: options.resultStatus === undefined
      ? "finished"
      : options.resultStatus,
    score: options.resultKind === "platform_error" ? null : options.score,
    accepted: options.accepted,
    details: {},
    created_at: now,
    finished_at: options.attemptState === "queued" ||
        options.attemptState === "judging"
      ? null
      : now,
  });
  await getDb().update(submissions).set({
    is_valid: options.valid,
    is_accepted: options.accepted,
    ...(options.active ? { active_attempt_id: attemptId } : {
      latest_attempt_id: attemptId,
      effective_attempt_id: attemptId,
    }),
  }).where(eq(submissions.id, submissionId));
  return { submissionId, attemptId };
}

/**
 * 给已有提交追加一次重测/平台失败尝试，并把"最近尝试"指向它
 * （有效成绩指针保持旧正式判定不动——真实投影在重测期间就是这样）。
 */
async function addLaterAttempt(
  submissionId: string,
  problemId: string,
  options: {
    sequence: number;
    state: AttemptState;
    resultKind: AttemptResultKind | null;
    resultStatus: string | null;
    score?: number | null;
    accepted?: boolean;
  },
): Promise<string> {
  const attemptId = crypto.randomUUID();
  await getDb().insert(evaluationAttempts).values({
    id: attemptId,
    submission_id: submissionId,
    problem_id: problemId,
    sequence: options.sequence,
    source: "rejudge",
    state: options.state,
    result_kind: options.resultKind,
    result_status: options.resultStatus,
    score: options.score ?? null,
    accepted: options.accepted ?? false,
    details: {},
    created_at: now,
    finished_at: options.state === "queued" || options.state === "judging"
      ? null
      : now,
  });
  await getDb().update(submissions).set({
    active_attempt_id: options.state === "queued" ||
        options.state === "judging"
      ? attemptId
      : null,
    latest_attempt_id: attemptId,
  }).where(eq(submissions.id, submissionId));
  return attemptId;
}

Deno.test({
  name:
    "stats(#50/#52): 重测中与平台错误不使已有有效成绩消失，total 与 valid 分离",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const userId = await seedUser("effective-stats");
    const problemId = await seedProblem(941001);

    try {
      // ① 一次满分正式判定（唯一提交）
      const { submissionId } = await seedCodeSubmission(problemId, userId, {
        score: FULL_SCORE,
        accepted: true,
        valid: true,
      });

      let detail = await getProblemStatsDetail(problemId);
      assertEquals(detail.submit_count, 1);
      assertEquals(detail.valid_submissions, 1);
      assertEquals(detail.accepted_count, 1);
      assertEquals(detail.acceptance_rate, 1);

      // ② 重测进行中：源状态 pending + 在途尝试，有效判定（投影与有效指针）保留
      await addLaterAttempt(submissionId, problemId, {
        sequence: 1,
        state: "queued",
        resultKind: null,
        resultStatus: null,
      });
      await db.update(submissions).set({ status: "pending" }).where(
        eq(submissions.id, submissionId),
      );

      detail = await getProblemStatsDetail(problemId);
      assertEquals(detail.submit_count, 1);
      assertEquals(detail.valid_submissions, 1);
      assertEquals(detail.accepted_count, 1);
      assertEquals(
        detail.acceptance_rate,
        1,
        "重测中已有满分不得从通过率中消失",
      );

      // ③ 平台失败：源状态 error，已有有效成绩同样不得消失
      await addLaterAttempt(submissionId, problemId, {
        sequence: 2,
        state: "error",
        resultKind: "platform_error",
        resultStatus: "error",
      });
      await db.update(submissions).set({ status: "error" }).where(
        eq(submissions.id, submissionId),
      );
      detail = await getProblemStatsDetail(problemId);
      assertEquals(detail.submit_count, 1);
      assertEquals(detail.valid_submissions, 1);
      assertEquals(detail.accepted_count, 1);
      assertEquals(detail.acceptance_rate, 1);

      // ④ 尚未判定的新提交：计入 total，不计入 valid 与通过率分母
      await seedCodeSubmission(problemId, userId, {
        score: 0,
        accepted: false,
        valid: false,
        submissionStatus: "pending",
        attemptState: "queued",
        resultStatus: null,
      });
      detail = await getProblemStatsDetail(problemId);
      assertEquals(detail.submit_count, 2);
      assertEquals(detail.valid_submissions, 1);
      assertEquals(detail.accepted_count, 1);
      assertEquals(detail.acceptance_rate, 1);

      const publicStats = await getPublicProblemStats(problemId);
      assertEquals(publicStats.submit_count, 2);
      assertEquals(publicStats.valid_submissions, 1);
      assertEquals(publicStats.accepted_count, 1);
      assertEquals(publicStats.acceptance_rate, 1);
    } finally {
      await db.delete(evaluationAttempts).where(
        eq(evaluationAttempts.problem_id, problemId),
      );
      await db.delete(submissions).where(eq(submissions.problem_id, problemId));
      await deleteProblemFixtures(eq(problems.id, problemId));
      await db.delete(users).where(eq(users.id, userId));
    }
  },
});

Deno.test({
  name: "rankings(#50/#51): 重测中保留通过，客观题纳入统一聚合且按题目去重",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const codeUserId = await seedUser("unified-code");
    const objectiveUserId = await seedUser("unified-objective");
    const codeProblemId = await seedProblem(941010);
    const paperId = await seedProblem(941011, true);

    try {
      // 代码题：已通过，随后重测进行中（源状态 pending，投影保留）
      const passed = await seedCodeSubmission(codeProblemId, codeUserId, {
        score: FULL_SCORE,
        accepted: true,
        valid: true,
      });
      // 同一题另一次练习提交（同用户第二次，去重后仍算 1 题）
      await seedCodeSubmission(codeProblemId, codeUserId, {
        score: 0,
        accepted: false,
        valid: true,
      });
      await db.update(submissions).set({ status: "pending" }).where(
        eq(submissions.id, passed.submissionId),
      );

      // 客观题：同套卷两次练习提交，均满分（is_accepted 投影）
      const paperSubmissions = [crypto.randomUUID(), crypto.randomUUID()];
      for (const id of paperSubmissions) {
        const attemptId = crypto.randomUUID();
        await db.insert(objectiveSubmissions).values({
          id,
          paper_id: paperId,
          ...await problemExecutionForTest(paperId),
          user_id: objectiveUserId,
          submission_type: "practice",
          answers: {},
          status: "finished",
          score: FULL_SCORE,
          details: {},
          created_at: now,
        });
        await db.insert(evaluationAttempts).values({
          id: attemptId,
          objective_submission_id: id,
          problem_id: paperId,
          sequence: 0,
          source: "initial",
          state: "finished",
          result_kind: "graded",
          result_status: "finished",
          score: FULL_SCORE,
          accepted: true,
          created_at: now,
          finished_at: now,
        });
        await db.update(objectiveSubmissions).set({
          is_valid: true,
          is_accepted: true,
          latest_attempt_id: attemptId,
          effective_attempt_id: attemptId,
        }).where(eq(objectiveSubmissions.id, id));
      }

      const page = await getGlobalRankings({ page: 1, limit: 100 });
      const codeRow = page.data.find((row) => row.user_id === codeUserId);
      const objectiveRow = page.data.find((row) =>
        row.user_id === objectiveUserId
      );

      // 重测中不丢通过（#50）
      assertEquals(codeRow?.solved_count, 1);
      assertEquals(codeRow?.total_submissions, 2);
      assertEquals(codeRow?.valid_submissions, 2);
      assertEquals(codeRow?.acceptance_rate, 0.5);

      // 仅通过客观题的用户同样上榜，且同题多次提交只计 1 题（#51）
      assertEquals(objectiveRow?.solved_count, 1);
      assertEquals(objectiveRow?.total_submissions, 2);
      assertEquals(objectiveRow?.valid_submissions, 2);
      assertEquals(objectiveRow?.acceptance_rate, 1);
    } finally {
      await db.delete(evaluationAttempts).where(
        eq(evaluationAttempts.problem_id, codeProblemId),
      );
      await db.delete(evaluationAttempts).where(
        eq(evaluationAttempts.problem_id, paperId),
      );
      await db.delete(submissions).where(
        eq(submissions.problem_id, codeProblemId),
      );
      await db.delete(objectiveSubmissions).where(
        eq(objectiveSubmissions.paper_id, paperId),
      );
      await deleteProblemFixtures(
        eq(problems.id, codeProblemId),
      );
      await deleteProblemFixtures(eq(problems.id, paperId));
      await db.delete(users).where(eq(users.id, codeUserId));
      await db.delete(users).where(eq(users.id, objectiveUserId));
    }
  },
});

Deno.test({
  name: "dashboard(#52): 实际提交数与有效提交数分离，未判定提交不进入通过率",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const userId = await seedUser("dashboard-effective");
    const problemId = await seedProblem(941020);

    try {
      await seedCodeSubmission(problemId, userId, {
        score: FULL_SCORE,
        accepted: true,
        valid: true,
      });
      await seedCodeSubmission(problemId, userId, {
        score: 0,
        accepted: false,
        valid: false,
        submissionStatus: "pending",
        attemptState: "queued",
        resultStatus: null,
      });

      const stats = await getDashboardStats();
      assertEquals(stats.total_submissions, 2, "实际提交数含未判定提交");
      assertEquals(stats.valid_submissions, 1, "有效数只认已产生正式判定");
      assertEquals(stats.total_accepted, 1);
      assertEquals(stats.acceptance_rate, 1, "通过率分母为有效判定数");
    } finally {
      await db.delete(evaluationAttempts).where(
        eq(evaluationAttempts.problem_id, problemId),
      );
      await db.delete(submissions).where(eq(submissions.problem_id, problemId));
      await deleteProblemFixtures(eq(problems.id, problemId));
      await db.delete(users).where(eq(users.id, userId));
    }
  },
});
