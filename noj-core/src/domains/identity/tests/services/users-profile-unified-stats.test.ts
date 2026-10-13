/**
 * 个人主页统一聚合回归（Handbook §3.4/§6.6，缺陷 #51）。
 *
 * 个人资料的通过数 / 通过列表 / 提交数必须**同时**覆盖两类正式提交
 * （代码提交 + 客观题提交），并按题目 ID 去重；修复前只读 `submissions`，
 * 仅通过客观题的用户 solved_count = 0，与其全局排行/题解门槛口径不一致。
 */
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { eq, inArray } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { getUserProfileAggregate } from "../../index.ts";

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
  title: string,
  objective = false,
): Promise<string> {
  const id = crypto.randomUUID();
  await getDb().insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id,
    title,
    description: "d",
    difficulty: "easy",
    runtime_config: null,
    number,
    owner_id: "0",
    is_objective: objective,
    created_at: now,
    updated_at: now,
  });
  return id;
}

Deno.test({
  name: "profile(#51): 客观题纳入 solved_count / 通过列表 / 提交数，按题目去重",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const userId = await seedUser("profile-unified");
    const paperId = await seedProblem(941101, "客观题套卷", true);
    const codeProblemId = await seedProblem(941102, "代码题");

    try {
      // 客观题：两次练习提交（一次满分、一次未满分），满分即通过
      for (
        const [score, accepted] of [[FULL_SCORE, true], [6000, false]] as const
      ) {
        const submissionId = crypto.randomUUID();
        const attemptId = crypto.randomUUID();
        await db.insert(objectiveSubmissions).values({
          id: submissionId,
          paper_id: paperId,
          user_id: userId,
          submission_type: "practice",
          answers: {},
          status: "finished",
          score,
          details: {},
          created_at: now,
        });
        await db.insert(evaluationAttempts).values({
          id: attemptId,
          objective_submission_id: submissionId,
          problem_id: paperId,
          sequence: 0,
          source: "initial",
          state: "finished",
          result_kind: "graded",
          result_status: "finished",
          score,
          accepted,
          created_at: now,
          finished_at: now,
        });
        await db.update(objectiveSubmissions).set({
          is_valid: true,
          is_accepted: accepted,
          latest_attempt_id: attemptId,
          effective_attempt_id: attemptId,
        }).where(eq(objectiveSubmissions.id, submissionId));
      }

      // 代码题：一次满分通过
      const codeSubmissionId = crypto.randomUUID();
      const codeAttemptId = crypto.randomUUID();
      await db.insert(submissions).values({
        id: codeSubmissionId,
        user_id: userId,
        problem_id: codeProblemId,
        language: "python3",
        code: "print(1)",
        status: "finished",
        created_at: now,
      });
      await db.insert(evaluationAttempts).values({
        id: codeAttemptId,
        submission_id: codeSubmissionId,
        problem_id: codeProblemId,
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
      await db.update(submissions).set({
        is_valid: true,
        is_accepted: true,
        latest_attempt_id: codeAttemptId,
        effective_attempt_id: codeAttemptId,
      }).where(eq(submissions.id, codeSubmissionId));

      const profile = await getUserProfileAggregate(userId, false, {
        viewerId: userId,
      });

      // 2 道题通过（客观题 + 代码题）；3 条提交全部有效；2 条通过
      assertEquals(profile.stats.solved_count, 2);
      assertEquals(profile.stats.total_submissions, 3);
      assertEquals(profile.stats.valid_submissions, 3);
      assertEquals(profile.stats.accepted, 2);
      assertEquals(profile.stats.acceptance_rate, 0.667);

      const solvedIds = profile.solved_problems.map((row) => row.id).sort();
      assertEquals(solvedIds, [paperId, codeProblemId].sort());
      const paperSolved = profile.solved_problems.find((row) =>
        row.id === paperId
      );
      assertExists(paperSolved);
      assertEquals(paperSolved.title, "客观题套卷");

      // 最近提交：两类提交都出现，客观题以 language='objective' 统一
      const languages = profile.recent_submissions.map((row) => row.language);
      assertEquals(
        languages.filter((value) => value === "objective").length,
        2,
      );
      assertEquals(
        profile.recent_submissions.filter((row) =>
          row.problem_id === codeProblemId
        ).length,
        1,
      );
    } finally {
      await db.delete(evaluationAttempts).where(
        inArray(evaluationAttempts.problem_id, [paperId, codeProblemId]),
      );
      await db.delete(objectiveSubmissions).where(
        eq(objectiveSubmissions.paper_id, paperId),
      );
      await db.delete(submissions).where(
        eq(submissions.problem_id, codeProblemId),
      );
      await db.delete(problems).where(
        inArray(problems.id, [paperId, codeProblemId]),
      );
      await db.delete(users).where(eq(users.id, userId));
    }
  },
});
