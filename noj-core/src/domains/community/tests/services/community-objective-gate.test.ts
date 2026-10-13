import { deleteProblemFixtures } from "../../../../../tests/helper.ts";
/**
 * 题解通过门槛统一聚合回归（Handbook §3.4/§6.6，缺陷 #51）。
 *
 * `hasAcceptedSolution` 是题解发布门槛与社区写入口径的单一判定：必须与个人资料、
 * 全局排行一致地覆盖**两类正式提交**。修复前只查 `submissions`，仅通过客观题
 * （满分即通过）的用户无法发布题解。
 */
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { assertEquals } from "jsr:@std/assert@^1";
import { eq, inArray } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { hasAcceptedSolution } from "../../index.ts";

await resetDbForTest({ refreshRankings: true });

const now = new Date().toISOString();
const FULL_SCORE = 10000;

import { publishBaselineVersionForTest } from "../../../../../tests/helper.ts";

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
    title: `门槛-${number}`,
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

async function seedObjectiveSubmission(
  paperId: string,
  userId: string,
  accepted: boolean,
): Promise<void> {
  const submissionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await getDb().insert(objectiveSubmissions).values({
    id: submissionId,
    paper_id: paperId,
    user_id: userId,
    submission_type: "practice",
    answers: {},
    status: "finished",
    score: accepted ? FULL_SCORE : 5000,
    details: {},
    created_at: now,
  });
  await getDb().insert(evaluationAttempts).values({
    id: attemptId,
    objective_submission_id: submissionId,
    problem_id: paperId,
    sequence: 0,
    source: "initial",
    state: "finished",
    result_kind: "graded",
    result_status: "finished",
    score: accepted ? FULL_SCORE : 5000,
    accepted,
    created_at: now,
    finished_at: now,
  });
  await getDb().update(objectiveSubmissions).set({
    is_valid: true,
    is_accepted: accepted,
    latest_attempt_id: attemptId,
    effective_attempt_id: attemptId,
  }).where(eq(objectiveSubmissions.id, submissionId));
}

Deno.test({
  name: "community gate(#51): 客观题满分满足题解通过门槛，未满分不满足",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const objectivePasser = await seedUser("gate-objective-pass");
    const objectiveFailer = await seedUser("gate-objective-fail");
    const codePasser = await seedUser("gate-code-pass");
    const paperId = await seedProblem(941201, true);
    const codeProblemId = await seedProblem(941202);

    try {
      await seedObjectiveSubmission(paperId, objectivePasser, true);
      await seedObjectiveSubmission(paperId, objectiveFailer, false);

      const codeSubmissionId = crypto.randomUUID();
      const codeAttemptId = crypto.randomUUID();
      await db.insert(submissions).values({
        id: codeSubmissionId,
        user_id: codePasser,
        problem_id: codeProblemId,
        language: "python3",
        code: "print(1)",
        status: "finished",
        is_valid: true,
        is_accepted: true,
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
        latest_attempt_id: codeAttemptId,
        effective_attempt_id: codeAttemptId,
      }).where(eq(submissions.id, codeSubmissionId));

      // 仅通过客观题的用户必须满足门槛（修复前为 false）
      assertEquals(
        await hasAcceptedSolution(objectivePasser, paperId),
        true,
        "客观题满分必须满足题解通过门槛",
      );
      assertEquals(
        await hasAcceptedSolution(objectiveFailer, paperId),
        false,
        "客观题未满分不得满足门槛",
      );
      // 代码提交口径不受影响
      assertEquals(await hasAcceptedSolution(codePasser, codeProblemId), true);
      assertEquals(await hasAcceptedSolution(codePasser, paperId), false);
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
      await deleteProblemFixtures(
        inArray(problems.id, [paperId, codeProblemId]),
      );
      await db.delete(users).where(
        inArray(users.id, [objectivePasser, objectiveFailer, codePasser]),
      );
    }
  },
});
