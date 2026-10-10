/**
 * 榜单物化视图刷新回归（Handbook §3.5，缺陷 #49）——**仅真实 PostgreSQL 运行**。
 *
 * PGlite 没有物化视图（`hasMaterializedView()` 返回 false，读取恒走内联路径），
 * 因此本文件在无 `DATABASE_URL` 时整体忽略，需由 Lead 在真实 PG 上**串行**执行：
 *
 *   cd noj-core && BCRYPT_SALT_ROUNDS=4 deno test -A --no-check \
 *     --preload=tests/preload.ts src/domains/query/tests/services/rankings-view-refresh.pg.test.ts
 *
 * 验证点：
 * 1. 视图落后（`materialized_revision < data_revision`）时读取走**内联**路径，
 *    新成绩立即可见，不依赖视图刷新；
 * 2. `refreshRankingsView()` 在数据库 advisory lock 内刷新，并把**其覆盖的
 *    revision** 记录到 `materialized_revision`；
 * 3. 视图口径与内联查询一致（两类提交、有效分母、赛期与 affect_global_ranking
 *    过滤），即 0108 重建后的定义可以安全标为可信；
 * 4. 刷新后再次发生数据变化仍视为落后（不把旧视图当最新）。
 */
import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { eq, inArray, sql } from "drizzle-orm";
import {
  disableTestTransactionForFile,
  getDb,
} from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { getGlobalRankings, refreshRankingsView } from "../../index.ts";
import { unwrapRows } from "../../../../shared/base/sql-rows.ts";

const hasPg = !!Deno.env.get("DATABASE_URL");

// 本文件专门验证物化视图刷新：`REFRESH MATERIALIZED VIEW CONCURRENTLY` 不允许在
// 事务块内执行，且 `refreshRankingsView()` 在测试事务内主动跳过（见 rankings.ts）。
// 因此必须关闭 preload 事务包装；用例自带唯一 runId 夹具并显式清理。
if (hasPg) disableTestTransactionForFile();

const now = new Date().toISOString();
const FULL_SCORE = 10000;

async function readRevisions(): Promise<{
  data: number;
  materialized: number;
}> {
  const result = await getDb().execute(
    sql`SELECT data_revision, materialized_revision FROM query_projection_revisions WHERE scope_key = 'global'`,
  );
  const rows = unwrapRows<
    { data_revision: number; materialized_revision: number }
  >(
    result as never,
  );
  return {
    data: Number(rows[0]?.data_revision ?? 0),
    materialized: Number(rows[0]?.materialized_revision ?? 0),
  };
}

async function bumpGlobalRevision(): Promise<void> {
  await getDb().execute(
    sql`INSERT INTO query_projection_revisions (scope_key, data_revision, materialized_revision) VALUES ('global', 1, 0) ON CONFLICT (scope_key) DO UPDATE SET data_revision = query_projection_revisions.data_revision + 1`,
  );
}

Deno.test({
  name:
    "rankings view(#49): 落后时读内联，刷新在 advisory lock 内记录覆盖 revision 且与内联口径一致",
  ignore: !hasPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const runId = crypto.randomUUID().slice(0, 8);
    const userId = `pg-rank-${runId}`;
    const problemId = `pg-rank-p-${runId}`;
    const paperId = `pg-rank-o-${runId}`;
    const codeSubmissionId = `pg-rank-s-${runId}`;
    const codeAttemptId = `pg-rank-a-${runId}`;
    const objectiveSubmissionId = `pg-rank-os-${runId}`;
    const objectiveAttemptId = `pg-rank-oa-${runId}`;

    await db.insert(users).values({
      id: userId,
      username: `pg-rank-${runId}`,
      email: `pg-rank-${runId}@example.com`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    });
    for (
      const [id, number, objective] of [
        [problemId, 990001, false],
        [paperId, 990002, true],
      ] as const
    ) {
      await db.insert(problems).values({
        id,
        title: `PG 视图口径-${number}`,
        description: "d",
        difficulty: "easy",
        runtime_config: null,
        number,
        owner_id: userId,
        type: objective ? "U" : "P",
        is_objective: objective,
        visibility: "public",
        created_at: now,
        updated_at: now,
      });
    }
    await db.insert(submissions).values({
      id: codeSubmissionId,
      user_id: userId,
      problem_id: problemId,
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
      problem_id: problemId,
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
    await db.insert(objectiveSubmissions).values({
      id: objectiveSubmissionId,
      paper_id: paperId,
      user_id: userId,
      submission_type: "practice",
      answers: {},
      status: "finished",
      score: 6000,
      details: {},
      is_valid: true,
      is_accepted: false,
      created_at: now,
    });
    await db.insert(evaluationAttempts).values({
      id: objectiveAttemptId,
      objective_submission_id: objectiveSubmissionId,
      problem_id: paperId,
      sequence: 0,
      source: "initial",
      state: "finished",
      result_kind: "graded",
      result_status: "finished",
      score: 6000,
      accepted: false,
      created_at: now,
      finished_at: now,
    });
    await db.update(objectiveSubmissions).set({
      latest_attempt_id: objectiveAttemptId,
      effective_attempt_id: objectiveAttemptId,
    }).where(eq(objectiveSubmissions.id, objectiveSubmissionId));

    // 让视图落后：读取必须走内联路径，新成绩立即可见
    await bumpGlobalRevision();
    const lagging = await readRevisions();
    assertEquals(
      lagging.materialized < lagging.data,
      true,
      "测试前提：物化视图必须处于落后状态",
    );

    const inline = await getGlobalRankings({ page: 1, limit: 100 });
    const inlineRow = inline.data.find((row) => row.user_id === userId);
    assertExists(inlineRow, "落后时读取必须走内联路径并包含最新成绩");
    assertEquals(inlineRow.solved_count, 1);
    assertEquals(inlineRow.total_submissions, 2);
    assertEquals(inlineRow.valid_submissions, 2);
    assertEquals(inlineRow.acceptance_rate, 0.5);

    // 刷新：advisory lock 串行 + 记录覆盖 revision
    await refreshRankingsView();
    const refreshed = await readRevisions();
    assertEquals(
      refreshed.materialized,
      refreshed.data,
      "刷新后必须记录其覆盖的 revision",
    );

    // 视图口径必须与内联一致（两类提交 + 有效分母），否则不可标可信
    const viewResult = await getDb().execute(
      sql`SELECT total_submissions, valid_submissions, solved_count, acceptance_rate, rank FROM user_rankings WHERE user_id = ${userId}`,
    );
    const viewRows = unwrapRows<Record<string, unknown>>(viewResult as never);
    assertEquals(viewRows.length, 1, "刷新后视图必须包含该用户");
    assertEquals(Number(viewRows[0].total_submissions), 2);
    assertEquals(Number(viewRows[0].valid_submissions), 2);
    assertEquals(Number(viewRows[0].solved_count), 1);
    assertEquals(Number(viewRows[0].acceptance_rate), 0.5);

    // 刷新后再次变化 → 仍视为落后，不得把旧视图当最新
    await bumpGlobalRevision();
    const changed = await readRevisions();
    assertEquals(
      changed.materialized < changed.data,
      true,
      "刷新期间/之后的新变化必须继续视为落后",
    );
    const afterChange = await getGlobalRankings({ page: 1, limit: 100 });
    const afterRow = afterChange.data.find((row) => row.user_id === userId);
    assertExists(afterRow);
    assertEquals(afterRow.total_submissions, 2);

    // 清理：先删数据再刷新，避免把测试行留在物化视图里
    await db.delete(evaluationAttempts).where(
      inArray(evaluationAttempts.id, [codeAttemptId, objectiveAttemptId]),
    );
    await db.delete(objectiveSubmissions).where(
      eq(objectiveSubmissions.id, objectiveSubmissionId),
    );
    await db.delete(submissions).where(eq(submissions.id, codeSubmissionId));
    await db.delete(problems).where(inArray(problems.id, [problemId, paperId]));
    await db.delete(users).where(eq(users.id, userId));
    await refreshRankingsView();
    const cleaned = await readRevisions();
    assertEquals(cleaned.materialized, cleaned.data);
  },
});
