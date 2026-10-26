import { problemExecutionForTest } from "../../../../../tests/helper.ts";
import { contestProblemExecutionForTest } from "../../../../../tests/helper.ts";
import { deleteProblemFixtures } from "../../../../../tests/helper.ts";
/**
 * 真实 PostgreSQL 并发验证：结算快照的一致性（tracking #46）——需**串行**执行。
 *
 * 本文件使用真实 PostgreSQL 验证行锁排队（并发用例各自持锁）。
 *
 * 验证的协议（Handbook §5.1/§6.6）：
 * - 结算发布对题目取共享锁、对竞赛取更新锁，并在**同一事务**内读取结算条件、
 *   策略与榜单；结果写入（题目共享 + 竞赛共享 + 提交更新）与策略切换
 *   （题目共享 + 竞赛更新）都必须在结算提交后才能继续；
 * - 因此快照只能是"结算提交那一刻"的一致性视图：并发写入要么整体在快照之前
 *   （被计入），要么整体在快照之后（只影响实时榜）。
 */
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  contestParticipants,
  contestProblems,
  contestRankingSnapshots,
  contests,
  evaluationAttempts,
  problems,
  problemVersions,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { publishContestRankingSnapshot } from "../../index.ts";

const db = getDb();
const now = new Date().toISOString();
const baseTime = Date.now() - 3_600_000;
const atMinutes = (minutes: number) =>
  new Date(baseTime + minutes * 60_000).toISOString();

/** 极短等待；仅用于让被阻塞的事务进入 PostgreSQL 锁队列。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Barrier {
  waitLocked: Promise<void>;
  locked: () => void;
  waitRelease: Promise<void>;
  release: () => void;
}

/** 测试屏障：让并发事务精确停在"已持锁、尚未写入"的位置。 */
function createBarrier(): Barrier {
  let markLocked: () => void = () => {};
  let markRelease: () => void = () => {};
  const waitLocked = new Promise<void>((resolve) => {
    markLocked = resolve;
  });
  const waitRelease = new Promise<void>((resolve) => {
    markRelease = resolve;
  });
  return { waitLocked, locked: markLocked, waitRelease, release: markRelease };
}

async function seedUser(prefix: string): Promise<string> {
  const id = crypto.randomUUID();
  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(users).values({
    id,
    username: `${prefix}-${unique}`,
    email: `${prefix}-${unique}@example.com`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  return id;
}

Deno.test({
  name: "contest settlement(#46): 结算快照与并发结果写入互斥（真实 PG 屏障）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const runId = crypto.randomUUID().slice(0, 8);
    const userId = `pg-settle-user-${runId}`;
    const problemId = `pg-settle-problem-${runId}`;
    const contestId = `pg-settle-contest-${runId}`;
    const versionId = `${problemId}-v1`;
    const submissionId = `pg-settle-sub-${runId}`;
    const attemptV1 = `pg-settle-att-v1-${runId}`;
    const attemptV2 = `pg-settle-att-v2-${runId}`;
    const adminId = await seedUser(`pg-settle-admin-${runId}`);

    await db.insert(users).values({
      id: userId,
      username: `pg-settle-${runId}`,
      email: `pg-settle-${runId}@example.com`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problems).values({
      domain_id: DEFAULT_DOMAIN_ID,
      id: problemId,
      title: `结算一致性-${runId}`,
      description: "d",
      difficulty: "easy",
      number: 992001,
      owner_id: adminId,
      judge_type: "dual",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problemVersions).values({
      id: versionId,
      problem_id: problemId,
      version: 1,
      schema_version: 1,
      origin: "published",
      content: {
        kind: "ai",
        title: "v1",
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: {},
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      content_sha256: `sha-${versionId}`,
      published_at: now,
    } as never);
    await db.update(problems).set({ latest_version_id: versionId }).where(
      eq(problems.id, problemId),
    );
    await db.insert(contests).values({
      domain_id: DEFAULT_DOMAIN_ID,
      id: contestId,
      title: `结算一致性-${runId}`,
      start_time: atMinutes(-120),
      end_time: atMinutes(-1),
      type: "kaggle",
      config: {},
      created_by: adminId,
      created_at: now,
      updated_at: now,
    });
    await db.insert(contestProblems).values({
      ...await contestProblemExecutionForTest(contestId, problemId),
      contest_id: contestId,
      problem_id: problemId,
      label: "A",
      sort_order: 0,
      score: 10000,
      pinned_version_id: versionId,
      effective_version_mode: "any",
      required_version_id: null,
      effective_policy_revision: 0,
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
      ...await problemExecutionForTest(problemId),
      contest_id: contestId,
      language: "python3",
      code: "print(1)",
      status: "finished",
      version_origin: "known",
      submitted_version_id: versionId,
      is_contest_valid: true,
      created_at: atMinutes(-50),
    });
    await db.insert(evaluationAttempts).values({
      id: attemptV1,
      submission_id: submissionId,
      problem_id: problemId,
      problem_version_id: versionId,
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
      latest_attempt_id: attemptV1,
      effective_attempt_id: attemptV1,
      contest_effective_attempt_id: attemptV1,
    }).where(eq(submissions.id, submissionId));

    const barrier = createBarrier();
    let writerError: unknown = null;
    // 并发"结果写入"：先取竞赛更新锁（模拟结果写入的宿主锁），再写入新判定
    const writer = db.transaction(async (tx) => {
      await tx.select({ id: contests.id }).from(contests).where(
        eq(contests.id, contestId),
      ).for("update");
      barrier.locked();
      await barrier.waitRelease;
      await tx.insert(evaluationAttempts).values({
        id: attemptV2,
        submission_id: submissionId,
        problem_id: problemId,
        problem_version_id: versionId,
        sequence: 1,
        source: "rejudge",
        state: "finished",
        result_kind: "graded",
        result_status: "finished",
        score: 5000,
        accepted: true,
        created_at: now,
        finished_at: now,
      });
      await tx.update(submissions).set({
        latest_attempt_id: attemptV2,
        contest_effective_attempt_id: attemptV2,
      }).where(eq(submissions.id, submissionId));
    }).catch((err) => {
      writerError = err;
    });

    try {
      await barrier.waitLocked;
      const publishPromise = publishContestRankingSnapshot(contestId, adminId);
      // 结算必须等在并发写入提交之后（否则快照会与最终成绩不一致）
      const raced = await Promise.race([
        publishPromise.then(() => "resolved" as const),
        sleep(400).then(() => "blocked" as const),
      ]);
      assertEquals(raced, "blocked", "结算发布必须等待持锁的并发写入");

      barrier.release();
      await writer;
      assertEquals(writerError, null, "并发写入不得报错");
      const snapshot = await publishPromise;
      assertEquals(snapshot.version, 1);
      const row = snapshot.rows.find((item) => item.user_id === userId);
      assertExists(row);
      // 快照读到的必须是写入提交后的 5000 分（一致视图），而不是 10000
      assertEquals(row.problem_scores[0].best_score, 5000);
      assertEquals(row.problem_scores[0].effective_attempt_id, attemptV2);
    } finally {
      barrier.release();
      await writer.catch(() => {});
      await db.delete(contestRankingSnapshots).where(
        eq(contestRankingSnapshots.contest_id, contestId),
      );
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
      await deleteProblemFixtures(eq(problems.id, problemId));
      await db.delete(users).where(inArray(users.id, [userId, adminId]));
    }
  },
});
