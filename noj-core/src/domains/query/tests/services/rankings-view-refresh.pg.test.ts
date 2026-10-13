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
  contests,
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  getGlobalRankings,
  inspectRankingView,
  refreshRankingsView,
} from "../../index.ts";
import { updateContest } from "../../../contest/index.ts";
import { unwrapRows } from "../../../../shared/base/sql-rows.ts";
import { withRawTransaction } from "../../../../../tests/helper/pg-raw-connection.ts";

const hasPg = !!Deno.env.get("DATABASE_URL");

// 本文件专门验证物化视图刷新：`refreshRankingsView()` 会真实执行
// `REFRESH MATERIALIZED VIEW CONCURRENTLY`（该语句**允许**在事务块内执行，见
// rankings.ts 的根因勘误），并在测试事务内主动跳过（`isInsideTestTransaction()`
// 短路，属测试适配）。因此这里关闭 preload 事务包装，让刷新真正跑起来；
// 用例自带唯一 runId 夹具并显式清理。
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

/** 读取视图里某用户的聚合行（不存在返回 null）。 */
async function readViewRow(userId: string): Promise<
  {
    solved_count: number;
    total_submissions: number;
  } | null
> {
  const result = await getDb().execute(
    sql`SELECT solved_count, total_submissions FROM user_rankings WHERE user_id = ${userId}`,
  );
  const rows = unwrapRows<{ solved_count: number; total_submissions: number }>(
    result as never,
  );
  return rows[0] ?? null;
}

/** 极短等待；用于让竞赛自然跨越 end_time（问题 8 的"无写入也过期"场景）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// ── 2026-10-11 复审问题 8：赛期边界新鲜度 ─────────────────────────────────────

interface BoundaryFixture {
  userId: string;
  problemIds: string[];
  contestIds: string[];
  submissionIds: string[];
}

/** 竞赛用 public 形态：`updateContest` 对邀请赛要求非空邀请码，与本用例无关。 */
async function seedBoundaryContest(
  fixture: BoundaryFixture,
  runId: string,
  tag: string,
  endTime: string,
  affectGlobalRanking = true,
): Promise<string> {
  const contestId = `pg-b-c-${tag}-${runId}`;
  await getDb().insert(contests).values({
    id: contestId,
    title: `PG 赛期边界-${tag}`,
    start_time: new Date(Date.now() - 3_600_000).toISOString(),
    end_time: endTime,
    type: "kaggle",
    config: {},
    kind: "public",
    is_public: true,
    affect_global_ranking: affectGlobalRanking,
    created_by: fixture.userId,
    created_at: now,
    updated_at: now,
  });
  fixture.contestIds.push(contestId);
  return contestId;
}

async function seedBoundaryAcceptance(
  fixture: BoundaryFixture,
  runId: string,
  tag: string,
  contestId: string | null,
  number: number,
): Promise<void> {
  const problemId = `pg-b-p-${tag}-${runId}`;
  const submissionId = `pg-b-s-${tag}-${runId}`;
  const attemptId = `pg-b-a-${tag}-${runId}`;
  await getDb().insert(problems).values({
    id: problemId,
    title: `PG 赛期边界题-${tag}`,
    description: "d",
    difficulty: "easy",
    runtime_config: null,
    number,
    owner_id: fixture.userId,
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
  await getDb().insert(submissions).values({
    id: submissionId,
    user_id: fixture.userId,
    problem_id: problemId,
    contest_id: contestId,
    language: "python3",
    code: "print(1)",
    status: "finished",
    is_valid: true,
    is_accepted: true,
    created_at: now,
  });
  await getDb().insert(evaluationAttempts).values({
    id: attemptId,
    submission_id: submissionId,
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
  await getDb().update(submissions).set({
    latest_attempt_id: attemptId,
    effective_attempt_id: attemptId,
  }).where(eq(submissions.id, submissionId));
  fixture.problemIds.push(problemId);
  fixture.submissionIds.push(submissionId);
}

async function cleanupBoundaryFixture(fixture: BoundaryFixture): Promise<void> {
  if (fixture.submissionIds.length > 0) {
    await getDb().delete(evaluationAttempts).where(
      inArray(evaluationAttempts.submission_id, fixture.submissionIds),
    );
    await getDb().delete(submissions).where(
      inArray(submissions.id, fixture.submissionIds),
    );
  }
  if (fixture.contestIds.length > 0) {
    await getDb().delete(contests).where(
      inArray(contests.id, fixture.contestIds),
    );
  }
  if (fixture.problemIds.length > 0) {
    await getDb().delete(problems).where(
      inArray(problems.id, fixture.problemIds),
    );
  }
  await getDb().delete(users).where(eq(users.id, fixture.userId));
  // 清掉视图里的测试行，避免污染同一 schema 的后续用例
  await refreshRankingsView();
}

Deno.test({
  name:
    "rankings view(#8-①): 赛期自然结束且无任何新写入时，视图不再可信、内联口径正确",
  ignore: !hasPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const runId = crypto.randomUUID().slice(0, 8);
    const fixture: BoundaryFixture = {
      userId: `pg-b-user-${runId}`,
      problemIds: [],
      contestIds: [],
      submissionIds: [],
    };
    await db.insert(users).values({
      id: fixture.userId,
      username: `pg-b-${runId}`,
      email: `pg-b-${runId}@example.com`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    });
    // 竞赛在 0.6s 后自然结束；提交先落库并通过刷新进入"未结束"口径
    const contestId = await seedBoundaryContest(
      fixture,
      runId,
      "a",
      new Date(Date.now() + 600).toISOString(),
    );
    await seedBoundaryAcceptance(fixture, runId, "a", contestId, 990101);

    try {
      await refreshRankingsView();
      assertEquals(
        await readViewRow(fixture.userId),
        null,
        "刷新时竞赛尚未结束，视图不应包含该用户",
      );
      const fresh = await inspectRankingView();
      assertEquals(fresh.trusted, true, "刚刷新且未跨赛期边界时视图可信");

      // 关键：此后**没有任何写入**，只是时钟跨过了 end_time
      await sleep(1000);
      const stale = await inspectRankingView();
      assertEquals(stale.trusted, false, "跨越 end_time 后视图必须被判落后");
      assertEquals(stale.stale_by_boundary, true, "落后原因必须是赛期边界");
      assertEquals(
        stale.data_revision,
        stale.materialized_revision,
        "本场景 revision 完全不变，落后只能由赛期边界解释",
      );

      const page = await getGlobalRankings({ page: 1, limit: 100 });
      const row = page.data.find((item) => item.user_id === fixture.userId);
      assertExists(row, "内联口径必须已计入结束竞赛的提交");
      assertEquals(row.solved_count, 1);
      assertEquals(row.total_submissions, 1);
    } finally {
      await cleanupBoundaryFixture(fixture);
    }
  },
});

Deno.test({
  name: "rankings view(#8-②): 刷新后再跨过一个结束边界仍需刷新",
  ignore: !hasPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const runId = crypto.randomUUID().slice(0, 8);
    const fixture: BoundaryFixture = {
      userId: `pg-b2-user-${runId}`,
      problemIds: [],
      contestIds: [],
      submissionIds: [],
    };
    await db.insert(users).values({
      id: fixture.userId,
      username: `pg-b2-${runId}`,
      email: `pg-b2-${runId}@example.com`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    });
    const firstContest = await seedBoundaryContest(
      fixture,
      runId,
      "b1",
      new Date(Date.now() + 400).toISOString(),
    );
    await seedBoundaryAcceptance(fixture, runId, "b1", firstContest, 990102);

    try {
      // 等第一个竞赛结束后再刷新：此时视图口径与内联一致，可信
      await sleep(700);
      await refreshRankingsView();
      const trusted = await inspectRankingView();
      assertEquals(trusted.trusted, true, "跨越边界后刷新，视图应恢复可信");
      const viewRow = await readViewRow(fixture.userId);
      assertExists(viewRow);
      assertEquals(viewRow.solved_count, 1);

      // 再引入一个"刷新之后才结束"的竞赛：跨过它的 end_time 后必须再次落后
      const secondContest = await seedBoundaryContest(
        fixture,
        runId,
        "b2",
        new Date(Date.now() + 400).toISOString(),
      );
      await seedBoundaryAcceptance(fixture, runId, "b2", secondContest, 990103);
      await sleep(700);

      const staleAgain = await inspectRankingView();
      assertEquals(
        staleAgain.trusted,
        false,
        "刷新之后新结束的竞赛必须让视图再次落后",
      );
      assertEquals(staleAgain.stale_by_boundary, true);
      // 视图仍是刷新时的快照（只有 1 题通过），内联已经能看到 2 题
      const staleViewRow = await readViewRow(fixture.userId);
      assertExists(staleViewRow);
      assertEquals(staleViewRow.solved_count, 1, "视图尚未刷新");

      const page = await getGlobalRankings({ page: 1, limit: 100 });
      const row = page.data.find((item) => item.user_id === fixture.userId);
      assertExists(row);
      assertEquals(row.solved_count, 2, "内联口径必须已计入第二个竞赛");
    } finally {
      await cleanupBoundaryFixture(fixture);
    }
  },
});

Deno.test({
  name:
    "rankings view(#8-③): 修改 end_time / affect_global_ranking 立即失效（无需等边界）",
  ignore: !hasPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const runId = crypto.randomUUID().slice(0, 8);
    const fixture: BoundaryFixture = {
      userId: `pg-b3-user-${runId}`,
      problemIds: [],
      contestIds: [],
      submissionIds: [],
    };
    await db.insert(users).values({
      id: fixture.userId,
      username: `pg-b3-${runId}`,
      email: `pg-b3-${runId}@example.com`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    });
    // 初始：竞赛已结束但 affect_global_ranking=false → 提交不计入全站榜
    const contestId = await seedBoundaryContest(
      fixture,
      runId,
      "c",
      new Date(Date.now() - 60_000).toISOString(),
      false,
    );
    await seedBoundaryAcceptance(fixture, runId, "c", contestId, 990104);

    try {
      await bumpGlobalRevision();
      await refreshRankingsView();
      const trusted = await inspectRankingView();
      assertEquals(trusted.trusted, true, "测试前提：刷新后视图可信");
      assertEquals(
        await readViewRow(fixture.userId),
        null,
        "不计入全局榜的竞赛提交不应进入视图",
      );

      // ① 改 affect_global_ranking → 必须立即递增 global revision 并失效
      const revisionBefore = (await readRevisions()).data;
      await updateContest(contestId, { affect_global_ranking: true }, true);
      assertEquals(
        (await readRevisions()).data,
        revisionBefore + 1,
        "改 affect_global_ranking 必须递增 global data_revision",
      );
      const afterAffect = await inspectRankingView();
      assertEquals(afterAffect.trusted, false, "改开关后视图必须立即不可信");
      assertEquals(
        afterAffect.stale_by_boundary,
        false,
        "本场景由 revision 导致落后，而非赛期边界",
      );
      const included = await getGlobalRankings({ page: 1, limit: 100 });
      assertEquals(
        included.data.find((item) => item.user_id === fixture.userId)
          ?.solved_count,
        1,
        "开关生效后内联口径必须立即计入",
      );

      // ② 改 end_time 到未来 → 再次立即失效
      const beforeEndTime = (await readRevisions()).data;
      await updateContest(
        contestId,
        { end_time: new Date(Date.now() + 3_600_000).toISOString() },
        true,
      );
      assertEquals(
        (await readRevisions()).data,
        beforeEndTime + 1,
        "改 end_time 必须递增 global data_revision",
      );
      assertEquals(
        (await inspectRankingView()).trusted,
        false,
        "改结束时间后视图必须立即不可信",
      );
      const excluded = await getGlobalRankings({ page: 1, limit: 100 });
      assertEquals(
        excluded.data.find((item) => item.user_id === fixture.userId),
        undefined,
        "竞赛重新变为进行中后，内联口径必须立即排除该提交（用户无通过记录 → 不上榜）",
      );
    } finally {
      await cleanupBoundaryFixture(fixture);
    }
  },
});

// ── 2026-10-11 复审问题 4：materialized_at 必须取同一刷新事务的数据库时钟 ──────

/** 读取数据库当前时刻（与 materialized_at 同一格式，便于比较）。 */
async function readDbNowIso(): Promise<string> {
  const result = await getDb().execute(
    sql`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS iso`,
  );
  return String(unwrapRows<{ iso: string }>(result as never)[0]?.iso ?? "");
}

/** 规范 ISO（毫秒 + Z）：赛期边界守卫只认这一形态，非规范形态会 fail-closed。 */
function isCanonicalIso(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}

Deno.test({
  name:
    "rankings view(#4-①): 刷新事务等锁跨过比赛结束 → 事务时钟记账，绝不误判 trusted",
  ignore: !hasPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const runId = crypto.randomUUID().slice(0, 8);
    const fixture: BoundaryFixture = {
      userId: `pg-b4-user-${runId}`,
      problemIds: [],
      contestIds: [],
      submissionIds: [],
    };
    await db.insert(users).values({
      id: fixture.userId,
      username: `pg-b4-${runId}`,
      email: `pg-b4-${runId}@example.com`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    });
    // 竞赛在 ~0.9s 后结束；刷新事务会在"赛前"开始并被行锁阻塞到"赛后"
    const endTime = new Date(Date.now() + 900).toISOString();
    const contestId = await seedBoundaryContest(
      fixture,
      runId,
      "d",
      endTime,
    );
    await seedBoundaryAcceptance(fixture, runId, "d", contestId, 990105);

    // 屏障：另一条原生连接持 `query_projection_revisions('global')` 行锁
    let markLocked: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    let releaseBlocker: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = withRawTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT data_revision FROM query_projection_revisions WHERE scope_key = 'global' FOR UPDATE`,
      );
      markLocked();
      await released;
    });

    try {
      await locked;
      // 刷新事务在此开始（BEGIN + advisory lock），随后阻塞在行锁上
      const refreshPromise = refreshRankingsView();
      await sleep(400);
      const raced = await Promise.race([
        refreshPromise.then(() => "done" as const),
        sleep(50).then(() => "pending" as const),
      ]);
      assertEquals(
        raced,
        "pending",
        "测试前提：刷新事务必须被行锁阻塞在赛期边界之前",
      );

      // 等过 end_time 再放锁：刷新在"赛后"继续，但事务时钟仍是赛前
      await sleep(700);
      assertEquals(
        Date.now() > Date.parse(endTime),
        true,
        "测试前提：放锁时竞赛已自然结束",
      );
      releaseBlocker();
      await blocker;
      await refreshPromise;

      const freshness = await inspectRankingView();
      assertExists(freshness.materialized_at);
      assertEquals(
        isCanonicalIso(freshness.materialized_at),
        true,
        "materialized_at 必须规范化为可被边界守卫识别的 ISO 形态",
      );
      assertEquals(
        Date.parse(freshness.materialized_at) < Date.parse(endTime),
        true,
        "覆盖时刻必须是事务开始（数据库时钟），而不是等锁后的应用时间",
      );
      assertEquals(
        freshness.stale_by_boundary,
        true,
        "视图按赛前口径生成、却跨越了结束边界 → 必须判落后",
      );
      assertEquals(
        freshness.trusted,
        false,
        "此时绝不能把视图标为可信（旧实现会用应用时钟误判 trusted）",
      );

      // 内联口径必须已计入结束竞赛的提交
      const page = await getGlobalRankings({ page: 1, limit: 100 });
      const row = page.data.find((item) => item.user_id === fixture.userId);
      assertExists(row, "内联口径必须包含该用户");
      assertEquals(row.solved_count, 1);
    } finally {
      releaseBlocker();
      await blocker.catch(() => {});
      await cleanupBoundaryFixture(fixture);
    }
  },
});

Deno.test({
  name:
    "rankings view(#4-②): 应用时钟偏移不影响 materialized_at（以数据库时钟为准）",
  ignore: !hasPg,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const runId = crypto.randomUUID().slice(0, 8);
    const fixture: BoundaryFixture = {
      userId: `pg-b5-user-${runId}`,
      problemIds: [],
      contestIds: [],
      submissionIds: [],
    };
    await db.insert(users).values({
      id: fixture.userId,
      username: `pg-b5-${runId}`,
      email: `pg-b5-${runId}@example.com`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    });
    const contestId = await seedBoundaryContest(
      fixture,
      runId,
      "e",
      new Date(Date.now() - 60_000).toISOString(),
    );
    await seedBoundaryAcceptance(fixture, runId, "e", contestId, 990106);

    const realDate = globalThis.Date;
    const skewMs = 3_600_000; // 应用时钟故意快 1 小时
    try {
      const dbNowBefore = await readDbNowIso();
      // 只偏移应用的"当前时刻"：`new Date()` 与 `Date.now()` 快 1 小时
      const skewedDate = function (...args: unknown[]): Date {
        return args.length === 0
          ? new (realDate as unknown as new (ms: number) => Date)(
            realDate.now() + skewMs,
          )
          : new (realDate as unknown as new (...a: unknown[]) => Date)(...args);
      } as unknown as DateConstructor;
      skewedDate.now = () => realDate.now() + skewMs;
      skewedDate.parse = realDate.parse;
      skewedDate.UTC = realDate.UTC;

      try {
        globalThis.Date = skewedDate;
        await refreshRankingsView();
      } finally {
        globalThis.Date = realDate;
      }

      const dbNowAfter = await readDbNowIso();
      const freshness = await inspectRankingView();
      assertExists(freshness.materialized_at);
      const materializedMs = Date.parse(freshness.materialized_at);
      const dbBeforeMs = Date.parse(dbNowBefore);
      const dbAfterMs = Date.parse(dbNowAfter);

      assertEquals(isCanonicalIso(freshness.materialized_at), true);
      assertEquals(
        materializedMs >= dbBeforeMs - 5_000 &&
          materializedMs <= dbAfterMs + 5_000,
        true,
        "materialized_at 必须落在数据库时钟窗口内",
      );
      assertEquals(
        Math.abs(materializedMs - (realDate.now() + skewMs)) > 600_000,
        true,
        "不得使用被偏移的应用时钟（否则快 1 小时的应用时间会写进视图账本）",
      );
      // 结束后已跨越边界，因此本次刷新覆盖后视图应恢复可信
      assertEquals(freshness.trusted, true, "刷新覆盖边界后视图可信");
    } finally {
      globalThis.Date = realDate;
      await cleanupBoundaryFixture(fixture);
    }
  },
});
