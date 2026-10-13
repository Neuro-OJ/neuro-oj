import {
  bindPublishedProblemForTest,
  deleteProblemFixtures,
  problemExecutionForTest,
} from "../../../../../tests/helper.ts";
/**
 * 真实 PostgreSQL 并发屏障用例：**交叉竞赛的批量策略修改**
 * （2026-10-11 复审问题 2 / tracking task-8）。
 *
 * ## 复现的缺陷
 *
 * 批量受理（`acceptRejudgeJob`）原实现"先锁全部题目，再按题目顺序逐项取竞赛锁并
 * 重算投影"。投影重算会写提交行并递增 `query_projection_revisions`（含 `global`），
 * 于是可能出现：请求 A 已持有 `global` revision 锁，却仍在抢请求 B 持有的竞赛锁，
 * 而 B 也在等 A 持有的 `global` → PostgreSQL 40P01 死锁。
 * `changes.sort()`（题目 → 竞赛）只能决定同批次内的相对顺序，**无法**决定两批
 * 请求之间的竞赛获取顺序，所以它既不充分、也不是修复。
 *
 * ## 本用例构造的并发场景
 *
 * - A 批：题目 `p-a1`/`p-a2`（与 B 批**完全不相交**），策略修改落在竞赛
 *   `c-2`/`c-1`（先 `p-a1→c-2`，再 `p-a2→c-1`）；
 * - B 批：题目 `p-b1`/`p-b2`，策略修改落在竞赛 `c-1`/`c-2`
 *   （先 `p-b1→c-1`，再 `p-b2→c-2`）——两批竞赛集合**相交**。
 *
 * 修复前：A 先拿到 `c-2` 后在提交行上继续重算，B 先拿到 `c-1` 并推进 `global`
 * revision，随后 A 要 `global`、B 要 `c-2` → 环 → 其中一批 40P01。
 * （A/B 实测：临时恢复"只预锁题目"的旧获取方式时，本用例第 1 轮即失败并报
 * `40P01: ... select "id" from "contests" ... for update`；修复后 5 轮全绿。）
 *
 * 屏障（barrier）：用例先持有一条 `(p-a1, c-2)` 提交行的 `FOR UPDATE`，让 A 批
 * 在"已持有竞赛锁"之后停在重算的提交行上；确认两批都已阻塞（各自持有对方想要的
 * 锁）后释放屏障，从而**确定性**地复现"两批交错持锁"的窗口，而不是靠随机竞争。
 *
 * ## 断言
 *
 * 1. 两批受理都成功返回任务（没有 40P01 / 没有任何异常）；
 * 2. 4 条 `contest_problems` 策略各推进 1 个 revision，`contest:*` projection
 *    revision 各 +2、`global` +4；
 * 3. 连续 {@link ROUNDS} 轮完整重建夹具后，**最终策略与投影状态逐字节一致**
 *    （投影结果与并发顺序无关，且可重复运行稳定）。
 *
 * 仅在有真实 PostgreSQL（`DATABASE_URL`）时运行：PGlite 是单连接内存库，
 * 无法建立真实行锁竞争，也不能验证 40P01。本文件关闭 preload 事务包装
 * （并发用例必须各自持有真实事务），夹具按固定 ID 自愈清理。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { inArray, like, sql } from "drizzle-orm";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  disableTestTransactionForFile,
  getDb,
} from "../../../../shared/db/connection.ts";
import type { RootDb } from "../../../../shared/db/executor.ts";
import * as schema from "../../../../shared/db/schema.ts";
import {
  contestProblems,
  contests,
  evaluationAttempts,
  problems,
  problemVersions,
  queryProjectionRevisions,
  submissionJobItems,
  submissionJobs,
  submissions,
  submissionVersionResults,
  users,
} from "../../../../shared/db/schema.ts";
import {
  acceptRejudgeJob,
  type RejudgeRequest,
} from "../../services/versioning/rejudge-jobs.ts";
import { rawConnectionOptions } from "../../../../../tests/helper/pg-raw-connection.ts";

const HAS_PG = !!Deno.env.get("DATABASE_URL");
if (HAS_PG) disableTestTransactionForFile();

/** 并发重复轮数：要求连续 5 轮稳定（最终状态完全一致）。 */
const ROUNDS = 5;
/** 屏障连接标识：阻塞统计只算本用例自己发起的会话。 */
const APP_NAME = "noj-lock-order-barrier";
const PROBE_APP_NAME = "noj-lock-order-probe";
/** 屏障等待上限（毫秒）。 */
const WAIT_TIMEOUT_MS = 15_000;
/** 轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 20;

const PREFIX = "lk-order-";
/** 本用例自带的受理者（不依赖迁移种子里的 root 用户）。 */
const ACTOR = `${PREFIX}actor`;
const PROBLEM_A1 = `${PREFIX}p-a1`;
const PROBLEM_A2 = `${PREFIX}p-a2`;
const PROBLEM_B1 = `${PREFIX}p-b1`;
const PROBLEM_B2 = `${PREFIX}p-b2`;
const CONTEST_1 = `${PREFIX}c-1`;
const CONTEST_2 = `${PREFIX}c-2`;
/** 屏障提交行：属于 `(p-a1, c-2)`，即 A 批第一条策略的作用域。 */
const SUBMISSION_A1 = `${PREFIX}s-a1`;
const SUBMISSION_A2 = `${PREFIX}s-a2`;
const SUBMISSION_B1 = `${PREFIX}s-b1`;
const SUBMISSION_B2 = `${PREFIX}s-b2`;

const ALL_PROBLEMS = [
  PROBLEM_A1,
  PROBLEM_A2,
  PROBLEM_B1,
  PROBLEM_B2,
];
const ALL_CONTESTS = [CONTEST_1, CONTEST_2];

/** 题目版本 ID（每轮重建时由 `seedRound` 写入）。 */
function versionOf(problemId: string): string {
  return `${PREFIX}v-${problemId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 新建一条带标识的原生连接（复用 TEST_SCHEMA / search_path 启动参数）。 */
function createClient(appName: string): ReturnType<typeof postgres> {
  const url = Deno.env.get("DATABASE_URL");
  if (!url) throw new Error("DATABASE_URL 未设置：真实 PG 用例不应执行");
  return postgres(url, {
    max: 1,
    connection: { ...rawConnectionOptions(), application_name: appName },
  });
}

/** 原生连接 → drizzle 根连接（作为受理函数的 `testRootDb` 注入点）。 */
function testRootDbOf(client: ReturnType<typeof postgres>): RootDb {
  return drizzlePg(client, { schema }) as unknown as RootDb;
}

function errorCode(error: unknown): string | null {
  const candidate = error as
    | { code?: string; cause?: { code?: string } }
    | null
    | undefined;
  return candidate?.code ?? candidate?.cause?.code ?? null;
}

function errorText(error: unknown): string {
  const code = errorCode(error);
  return `${code ?? "NO_CODE"}: ${String(error)}`;
}

/** A / B 两批策略修改：题目不相交、竞赛相交（见文件头注释）。 */
function requestFor(batch: "a" | "b"): RejudgeRequest {
  if (batch === "a") {
    return {
      kind: "rejudge",
      scope: {
        type: "selected",
        submissions: [
          { kind: "submission", id: SUBMISSION_A1 },
          { kind: "submission", id: SUBMISSION_A2 },
        ],
      },
      target: { mode: "submitted" },
      policy_changes: [
        {
          problem_id: PROBLEM_A1,
          contest_id: CONTEST_2,
          expected_revision: 0,
          policy: { mode: "any" },
        },
        {
          problem_id: PROBLEM_A2,
          contest_id: CONTEST_1,
          expected_revision: 0,
          policy: { mode: "any" },
        },
      ],
    };
  }
  return {
    kind: "rejudge",
    scope: {
      type: "selected",
      submissions: [
        { kind: "submission", id: SUBMISSION_B1 },
        { kind: "submission", id: SUBMISSION_B2 },
      ],
    },
    target: { mode: "submitted" },
    policy_changes: [
      {
        problem_id: PROBLEM_B1,
        contest_id: CONTEST_1,
        expected_revision: 0,
        policy: { mode: "any" },
      },
      {
        problem_id: PROBLEM_B2,
        contest_id: CONTEST_2,
        expected_revision: 0,
        policy: { mode: "any" },
      },
    ],
  };
}

/** 重建本轮夹具：受理者 + 4 题 + 4 版本 + 2 竞赛 + 4 竞赛题关联 + 4 提交。 */
async function seedRound(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  const start = "2026-01-01T00:00:00.000Z";
  const end = "2026-12-31T00:00:00.000Z";

  await db.insert(users).values({
    id: ACTOR,
    username: ACTOR,
    email: `${ACTOR}@test.noj`,
    password_hash: "x",
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });

  await db.insert(problems).values([
    {
      domain_id: DEFAULT_DOMAIN_ID,
      id: PROBLEM_A1,
      title: "lock order A1",
      description: "d",
      number: 987101,
      owner_id: ACTOR,
      difficulty: "easy",
      judge_type: "dual",
      created_at: now,
      updated_at: now,
    },
    {
      domain_id: DEFAULT_DOMAIN_ID,
      id: PROBLEM_A2,
      title: "lock order A2",
      description: "d",
      number: 987102,
      owner_id: ACTOR,
      difficulty: "easy",
      judge_type: "dual",
      created_at: now,
      updated_at: now,
    },
    {
      domain_id: DEFAULT_DOMAIN_ID,
      id: PROBLEM_B1,
      title: "lock order B1",
      description: "d",
      number: 987103,
      owner_id: ACTOR,
      difficulty: "easy",
      judge_type: "dual",
      created_at: now,
      updated_at: now,
    },
    {
      domain_id: DEFAULT_DOMAIN_ID,
      id: PROBLEM_B2,
      title: "lock order B2",
      description: "d",
      number: 987104,
      owner_id: ACTOR,
      difficulty: "easy",
      judge_type: "dual",
      created_at: now,
      updated_at: now,
    },
  ]);

  for (const problemId of ALL_PROBLEMS) {
    await bindPublishedProblemForTest(problemId);
  }
  await db.insert(problemVersions).values(
    ALL_PROBLEMS.map((problemId) => ({
      id: versionOf(problemId),
      problem_id: problemId,
      version: 1,
      origin: "published" as const,
      content: {
        kind: "ai",
        title: problemId,
        description: "d",
        samples: [],
      } as unknown as Record<string, unknown>,
      published_at: now,
    })),
  );
  for (const problemId of ALL_PROBLEMS) {
    await db.update(problems).set({ latest_version_id: versionOf(problemId) })
      .where(inArray(problems.id, [problemId]));
  }

  await db.insert(contests).values([
    {
      domain_id: DEFAULT_DOMAIN_ID,
      id: CONTEST_1,
      title: "lock order contest 1",
      description: "",
      start_time: start,
      end_time: end,
      type: "kaggle",
      kind: "public",
      is_public: true,
      created_by: ACTOR,
      created_at: now,
      updated_at: now,
    },
    {
      domain_id: DEFAULT_DOMAIN_ID,
      id: CONTEST_2,
      title: "lock order contest 2",
      description: "",
      start_time: start,
      end_time: end,
      type: "kaggle",
      kind: "public",
      is_public: true,
      created_by: ACTOR,
      created_at: now,
      updated_at: now,
    },
  ]);

  await db.insert(contestProblems).values([
    {
      contest_id: CONTEST_2,
      problem_id: PROBLEM_A1,
      label: "A1",
      score: 100,
      sort_order: 0,
      pinned_version_id: versionOf(PROBLEM_A1),
      effective_policy_revision: 0,
    },
    {
      contest_id: CONTEST_1,
      problem_id: PROBLEM_A2,
      label: "A2",
      score: 100,
      sort_order: 1,
      pinned_version_id: versionOf(PROBLEM_A2),
      effective_policy_revision: 0,
    },
    {
      contest_id: CONTEST_1,
      problem_id: PROBLEM_B1,
      label: "B1",
      score: 100,
      sort_order: 0,
      pinned_version_id: versionOf(PROBLEM_B1),
      effective_policy_revision: 0,
    },
    {
      contest_id: CONTEST_2,
      problem_id: PROBLEM_B2,
      label: "B2",
      score: 100,
      sort_order: 1,
      pinned_version_id: versionOf(PROBLEM_B2),
      effective_policy_revision: 0,
    },
  ]);

  const submission = async (
    id: string,
    problemId: string,
    contestId: string,
  ): Promise<typeof submissions.$inferInsert> => ({
    ...(await problemExecutionForTest(problemId)),
    id,
    user_id: ACTOR,
    problem_id: problemId,
    contest_id: contestId,
    language: "python3",
    code: "print(1)",
    submitted_version_id: versionOf(problemId),
    version_origin: "known",
    status: "pending",
    created_at: now,
  });
  await db.insert(submissions).values(
    await Promise.all([
      submission(SUBMISSION_A1, PROBLEM_A1, CONTEST_2),
      submission(SUBMISSION_A2, PROBLEM_A2, CONTEST_1),
      submission(SUBMISSION_B1, PROBLEM_B1, CONTEST_1),
      submission(SUBMISSION_B2, PROBLEM_B2, CONTEST_2),
    ]),
  );
}

/**
 * 按固定 ID 自愈清理本用例的全部夹具（含已提交的任务、条目与 revision 行）。
 *
 * 本文件关闭了 preload 事务包装，失败中断会留下已提交的行；每轮开始/结束都清理，
 * 保证重复运行不因唯一约束或残留状态误报。删除顺序遵循外键依赖。
 */
async function cleanupFixedIds(): Promise<void> {
  const db = getDb();
  const jobs = await db.select({ id: submissionJobs.id }).from(submissionJobs)
    .where(like(submissionJobs.idempotency_key, `${PREFIX}%`));
  if (jobs.length > 0) {
    const jobIds = jobs.map((row) => row.id);
    await db.delete(submissionJobItems).where(
      inArray(submissionJobItems.job_id, jobIds),
    );
    await db.delete(submissionJobs).where(
      inArray(submissionJobs.id, jobIds),
    );
  }
  await db.delete(submissionVersionResults).where(
    inArray(submissionVersionResults.problem_id, ALL_PROBLEMS),
  );
  await db.delete(evaluationAttempts).where(
    inArray(evaluationAttempts.problem_id, ALL_PROBLEMS),
  );
  await db.delete(submissions).where(
    inArray(submissions.problem_id, ALL_PROBLEMS),
  );
  await db.delete(contestProblems).where(
    inArray(contestProblems.problem_id, ALL_PROBLEMS),
  );
  await db.delete(contests).where(inArray(contests.id, ALL_CONTESTS));
  // 题目行引用版本（latest/required）：先解开指针再删版本/题目
  await db.update(problems).set({
    latest_version_id: null,
    required_version_id: null,
    effective_version_mode: "any",
    effective_policy_revision: 0,
  }).where(inArray(problems.id, ALL_PROBLEMS));
  await db.delete(problemVersions).where(
    inArray(problemVersions.problem_id, ALL_PROBLEMS),
  );
  await deleteProblemFixtures(inArray(problems.id, ALL_PROBLEMS));
  await db.delete(queryProjectionRevisions).where(
    inArray(queryProjectionRevisions.scope_key, [
      "global",
      ...ALL_PROBLEMS.map((problemId) => `problem:${problemId}`),
      ...ALL_CONTESTS.map((contestId) => `contest:${contestId}`),
    ]),
  );
  // 本文件使用真实独立事务；只清理自己的默认域成员夹具并校准容量计数。
  await db.execute(
    sql`DELETE FROM domain_member_roles WHERE membership_id IN (SELECT id FROM domain_memberships WHERE user_id = ${ACTOR})`,
  );
  await db.execute(
    sql`DELETE FROM domain_memberships WHERE user_id = ${ACTOR}`,
  );
  await db.execute(
    sql`UPDATE domain_resource_counters counter SET used = (SELECT count(*) FROM domain_memberships membership WHERE membership.domain_id = counter.domain_id AND membership.status = 'active') WHERE counter.domain_id = ${DEFAULT_DOMAIN_ID} AND counter.resource = 'members'`,
  );
  await db.delete(users).where(inArray(users.id, [ACTOR]));
}

/** 统计本用例自己发起的、当前被阻塞（等待锁）的会话数。 */
async function countLockWaiters(
  probe: ReturnType<typeof postgres>,
): Promise<number> {
  const rows = await probe`
    SELECT count(DISTINCT l.pid)::int AS waiting
    FROM pg_locks l
    JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.granted = false AND a.application_name = ${APP_NAME}
  `;
  return (rows[0]?.waiting as number | undefined) ?? 0;
}

/** 屏障超时时的诊断快照：本用例相关会话在等什么锁。 */
async function describeWaiters(
  probe: ReturnType<typeof postgres>,
): Promise<string> {
  const rows = await probe`
    SELECT a.pid,
           a.application_name,
           a.state,
           a.wait_event_type,
           a.wait_event,
           l.locktype,
           l.granted,
           c.relname,
           left(a.query, 70) AS query
    FROM pg_stat_activity a
    LEFT JOIN pg_locks l ON l.pid = a.pid AND l.granted = false
    LEFT JOIN pg_class c ON c.oid = l.relation
    WHERE a.application_name LIKE 'noj-lock-order%'
    ORDER BY a.pid, l.locktype
  `;
  return JSON.stringify(rows);
}

/** 轮询直到至少 `expected` 个受理会话阻塞在行锁上；超时即判定屏障协议未建立。 */
async function waitForWaiters(
  probe: ReturnType<typeof postgres>,
  expected: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    if (await countLockWaiters(probe) >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(
        `${label}：等待 ${expected} 个受理会话阻塞在行锁上超时` +
          `（屏障协议未建立）：${await describeWaiters(probe)}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

interface RoundOutcome {
  /** 两批受理的异常（成功为空数组）。 */
  errors: unknown[];
  /** 两批受理返回的 job_id（顺序：A、B）。 */
  jobIds: string[];
  /** 两批受理返回的条目数。 */
  totalItems: number[];
}

/**
 * 执行一轮屏障并发受理：
 * 1. 屏障连接持有 `(p-a1, c-2)` 提交行的 `FOR UPDATE`；
 * 2. 启动 A 批并确认其已阻塞（此时 A 已持有部分竞赛锁）；
 * 3. 启动 B 批并确认两批都阻塞（交错持锁窗口建立，修复前即死锁点）；
 * 4. 释放屏障并等待两批结束。
 */
async function runBarrierRound(round: number): Promise<RoundOutcome> {
  const barrier = createClient(APP_NAME);
  const clientA = createClient(APP_NAME);
  const clientB = createClient(APP_NAME);
  const probe = createClient(PROBE_APP_NAME);
  let acceptingA: Promise<unknown> | null = null;
  let acceptingB: Promise<unknown> | null = null;
  let barrierOpen = false;
  try {
    await barrier`BEGIN`;
    barrierOpen = true;
    await barrier`SELECT id FROM submissions WHERE id = ${SUBMISSION_A1} FOR UPDATE`;

    acceptingA = acceptRejudgeJob(
      ACTOR,
      requestFor("a"),
      `${PREFIX}a-${round}`,
      testRootDbOf(clientA),
    );
    await waitForWaiters(probe, 1, `第 ${round + 1} 轮 A 批受理`);

    acceptingB = acceptRejudgeJob(
      ACTOR,
      requestFor("b"),
      `${PREFIX}b-${round}`,
      testRootDbOf(clientB),
    );
    await waitForWaiters(probe, 2, `第 ${round + 1} 轮 A/B 两批受理`);

    await barrier`COMMIT`;
    barrierOpen = false;
    const settled = await Promise.allSettled([
      acceptingA,
      acceptingB,
    ]);
    const errors: unknown[] = [];
    const jobIds: string[] = [];
    const totalItems: number[] = [];
    for (const entry of settled) {
      if (entry.status === "rejected") {
        errors.push(entry.reason);
        continue;
      }
      const value = entry.value as { job_id: string; total_items: number };
      jobIds.push(value.job_id);
      totalItems.push(value.total_items);
    }
    return { errors, jobIds, totalItems };
  } finally {
    // 兜底释放屏障：等待超时/断言失败也必须让两个受理事务能够结束
    if (barrierOpen) {
      try {
        await barrier`ROLLBACK`;
      } catch {
        // 连接已结束：忽略
      }
    }
    if (acceptingA || acceptingB) {
      await Promise.allSettled([
        acceptingA ?? Promise.resolve(null),
        acceptingB ?? Promise.resolve(null),
      ]);
    }
    await barrier.end({ timeout: 5 });
    await clientA.end({ timeout: 5 });
    await clientB.end({ timeout: 5 });
    await probe.end({ timeout: 5 });
  }
}

/** 读取本轮结束后的策略与投影状态摘要（镜像数据 revision + 分版本投影字段）。 */
async function projectionFingerprint(): Promise<string> {
  const db = getDb();
  const contestPolicies = await db.select({
    contest_id: contestProblems.contest_id,
    problem_id: contestProblems.problem_id,
    mode: contestProblems.effective_version_mode,
    required: contestProblems.required_version_id,
    pinned: contestProblems.pinned_version_id,
    revision: contestProblems.effective_policy_revision,
  }).from(contestProblems).where(
    inArray(contestProblems.problem_id, ALL_PROBLEMS),
  ).orderBy(contestProblems.contest_id, contestProblems.problem_id);

  const projectedSubmissions = await db.select({
    id: submissions.id,
    status: submissions.status,
    is_valid: submissions.is_valid,
    is_accepted: submissions.is_accepted,
    effective_attempt_id: submissions.effective_attempt_id,
    accepted_attempt_id: submissions.accepted_attempt_id,
    is_contest_valid: submissions.is_contest_valid,
    is_contest_accepted: submissions.is_contest_accepted,
    contest_effective_attempt_id: submissions.contest_effective_attempt_id,
    contest_accepted_attempt_id: submissions.contest_accepted_attempt_id,
    global_policy_revision: submissions.global_policy_revision,
    contest_policy_revision: submissions.contest_policy_revision,
  }).from(submissions).where(
    inArray(submissions.problem_id, ALL_PROBLEMS),
  ).orderBy(submissions.id);

  const revisions = await db.select({
    scope_key: queryProjectionRevisions.scope_key,
    data_revision: queryProjectionRevisions.data_revision,
  }).from(queryProjectionRevisions).where(
    inArray(queryProjectionRevisions.scope_key, [
      "global",
      ...ALL_PROBLEMS.map((problemId) => `problem:${problemId}`),
      ...ALL_CONTESTS.map((contestId) => `contest:${contestId}`),
    ]),
  ).orderBy(queryProjectionRevisions.scope_key);

  return JSON.stringify({ contestPolicies, projectedSubmissions, revisions });
}

Deno.test({
  name:
    "pg lock-order: 交叉竞赛的批量策略修改并发受理不死锁，且投影与顺序无关（问题2/task-8）",
  ignore: !HAS_PG,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const outcomes: RoundOutcome[] = [];
    const fingerprints: string[] = [];
    try {
      for (let round = 0; round < ROUNDS; round++) {
        await cleanupFixedIds();
        await seedRound();
        outcomes.push(await runBarrierRound(round));
        fingerprints.push(await projectionFingerprint());
      }

      // 1) 两批受理每一轮都必须成功：40P01 会让其中一批 reject 到这里
      for (const [index, outcome] of outcomes.entries()) {
        assertEquals(
          outcome.errors.map(errorText),
          [],
          `第 ${index + 1} 轮：两批批量策略修改都必须成功（不得出现 40P01）`,
        );
        assertEquals(
          outcome.totalItems,
          [2, 2],
          `第 ${index + 1} 轮：两批各 2 个条目`,
        );
        assertEquals(
          outcome.jobIds.length,
          2,
          `第 ${index + 1} 轮：两批都必须返回各自的 job_id`,
        );
      }
      assertEquals(
        outcomes.flatMap((outcome) => outcome.errors)
          .some((error) => errorCode(error) === "40P01"),
        false,
        "不得出现 PostgreSQL 40P01（deadlock detected）",
      );

      // 2) 策略状态：4 条竞赛题策略各推进 1 个 revision
      const db = getDb();
      const policies = await db.select({
        problem_id: contestProblems.problem_id,
        mode: contestProblems.effective_version_mode,
        revision: contestProblems.effective_policy_revision,
      }).from(contestProblems).where(
        inArray(contestProblems.problem_id, ALL_PROBLEMS),
      ).orderBy(contestProblems.problem_id);
      assertEquals(
        policies,
        [PROBLEM_A1, PROBLEM_A2, PROBLEM_B1, PROBLEM_B2].map((problemId) => ({
          problem_id: problemId,
          mode: "any",
          revision: 1,
        })),
        "每条竞赛题策略恰好被修改一次（revision 0 → 1）",
      );

      // 3) 投影 revision：contest:c-1/c-2 各 +2（每个竞赛被两批各改一次），
      //    global 每轮 +4（4 次策略重算各递增一次）——与并发顺序无关
      const revisions = await db.select({
        scope_key: queryProjectionRevisions.scope_key,
        data_revision: queryProjectionRevisions.data_revision,
      }).from(queryProjectionRevisions).where(
        inArray(queryProjectionRevisions.scope_key, [
          "global",
          `contest:${CONTEST_1}`,
          `contest:${CONTEST_2}`,
        ]),
      ).orderBy(queryProjectionRevisions.scope_key);
      assertEquals(
        revisions,
        [
          { scope_key: `contest:${CONTEST_1}`, data_revision: 2 },
          { scope_key: `contest:${CONTEST_2}`, data_revision: 2 },
          { scope_key: "global", data_revision: 4 },
        ],
        "投影 revision 增量只取决于写入次数，与并发顺序无关",
      );

      // 4) 5 轮完整重建后最终状态必须逐字节一致（可重复运行稳定）
      assertEquals(
        new Set(fingerprints).size,
        1,
        `连续 ${ROUNDS} 轮的最终策略与投影状态必须完全一致`,
      );
    } finally {
      await cleanupFixedIds();
    }
  },
});

/**
 * `testRootDb` 是测试专用注入点：**省略时的生产行为必须完全不变**。
 *
 * 本用例走与路由/服务完全相同的 3 参调用（`acceptRejudgeJob(actor, request, key)`，
 * 即 `getDb()` 单例 + 自开事务），断言受理正常生效、条目固定、幂等键可重放；
 * 与上面并发用例共用同一份夹具，因此"注入点存在"不会掩盖默认路径的回归。
 */
Deno.test({
  name: "pg lock-order: 省略 testRootDb 的生产受理路径行为不变（task-8 回归）",
  ignore: !HAS_PG,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try {
      await cleanupFixedIds();
      await seedRound();

      const key = `${PREFIX}prod-default`;
      const accepted = await acceptRejudgeJob(ACTOR, requestFor("a"), key);
      assertEquals(accepted.existing, false, "首次受理必须新建任务");
      assertEquals(accepted.total_items, 2, "条目集合在受理时固定");
      assertEquals(accepted.status, "queued");
      assertEquals(typeof accepted.job_id, "string");

      // 策略与任务同批生效：两条竞赛题策略 revision 0 → 1
      const db = getDb();
      const policies = await db.select({
        problem_id: contestProblems.problem_id,
        revision: contestProblems.effective_policy_revision,
      }).from(contestProblems).where(
        inArray(contestProblems.problem_id, [PROBLEM_A1, PROBLEM_A2]),
      ).orderBy(contestProblems.problem_id);
      assertEquals(policies, [
        { problem_id: PROBLEM_A1, revision: 1 },
        { problem_id: PROBLEM_A2, revision: 1 },
      ]);

      // 幂等：同 key 重放返回同一任务，且不重复推进策略 revision
      const repeat = await acceptRejudgeJob(ACTOR, requestFor("a"), key);
      assertEquals(repeat.existing, true);
      assertEquals(repeat.job_id, accepted.job_id);
      const afterRepeat = await db.select({
        revision: contestProblems.effective_policy_revision,
      }).from(contestProblems).where(
        inArray(contestProblems.problem_id, [PROBLEM_A1, PROBLEM_A2]),
      );
      assertEquals(
        afterRepeat.map((row) => row.revision),
        [1, 1],
        "幂等重放不得再次修改策略",
      );
    } finally {
      await cleanupFixedIds();
    }
  },
});
