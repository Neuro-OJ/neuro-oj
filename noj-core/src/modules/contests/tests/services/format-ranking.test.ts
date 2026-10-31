import { problemExecutionForTest } from "../../../../../tests/helper.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import { bindPublishedProblemForTest } from "../../../../../tests/helper.ts";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  contests,
  domainMemberships,
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  problemVersions,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { getSubmission, listSubmissions } from "../../../evaluations/index.ts";
import {
  addParticipants,
  createContest,
  getContestProblems,
  getContestRankingView,
  publishContestRankingSnapshot,
  updateContest,
} from "../../index.ts";
import type { ContestType } from "../../types/contests.ts";
await resetDbForTest();

async function problem(kind: "oi" | "ai" | "objective", number: number) {
  const db = getDb(), id = crypto.randomUUID(), version = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id,
    number,
    title: kind,
    description: "statement",
    judge_type: kind === "oi" ? "oi" : "dual",
    is_objective: kind === "objective",
    visibility: "public",
    owner_id: "0",
    created_at: now,
    updated_at: now,
  });
  await db.insert(problemVersions).values({
    id: version,
    problem_id: id,
    version: 1,
    content: { kind, title: kind },
    published_at: now,
  });
  await db.update(problems).set({ latest_version_id: version }).where(
    eq(problems.id, id),
  );
  await bindPublishedProblemForTest(id);
  return { id, version };
}

async function contest(type: ContestType, item: { id: string }) {
  const base = Date.now() - 300_000;
  const result = await createContest(
    {
      title: type,
      type,
      kind: "public",
      start_time: new Date(base).toISOString(),
      end_time: new Date(base + 7_200_000).toISOString(),
      freeze_duration_seconds: 0,
      problems: [{
        problem_id: item.id,
        score: 5000,
        label: "A",
        sort_order: 0,
      }],
    },
    "0",
    true,
  );
  await addParticipants(result.id, ["0"]);
  return { ...result, base };
}

async function receipt(
  c: { id: string; base: number },
  p: { id: string; version: string },
  minute: number,
  score: number | null,
  verdict = "WA",
  formal = true,
  userId = "0",
) {
  const db = getDb(), id = crypto.randomUUID(), attempt = crypto.randomUUID();
  await db.insert(submissions).values({
    id,
    contest_id: c.id,
    user_id: userId,
    problem_id: p.id,
    ...await problemExecutionForTest(p.id),
    language: "cc",
    code: "code",
    version_origin: "known",
    submitted_version_id: p.version,
    status: score === null ? "pending" : "finished",
    created_at: new Date(c.base + minute * 60_000).toISOString(),
  });
  await db.insert(evaluationAttempts).values({
    id: attempt,
    submission_id: id,
    problem_id: p.id,
    problem_version_id: p.version,
    sequence: 0,
    source: "initial",
    state: formal ? "finished" : "error",
    result_kind: formal ? "graded" : "platform_error",
    result_status: verdict,
    score,
    accepted: verdict === "AC",
    details: { oi: { verdict } },
    created_at: new Date().toISOString(),
  });
  await db.update(submissions).set({
    latest_attempt_id: attempt,
    contest_effective_attempt_id: formal ? attempt : null,
    is_contest_valid: formal,
    is_contest_accepted: formal && verdict === "AC",
  }).where(eq(submissions.id, id));
  return { id, attempt };
}

Deno.test("赛制榜单：最后受理提交、平台失败等待、正式快照不随重测改写", async () => {
  const p = await problem("oi", 978001), c = await contest("ioi", p);
  await receipt(c, p, 1, 10000, "AC");
  const latest = await receipt(c, p, 2, 2000);
  let result = await getContestRankingView(c.id, "ioi", false, "0");
  assertEquals(result.rows[0].total_score, 1000);
  assertEquals(result.rows[0].problem_scores[0].pending, false);
  assertEquals(
    (await getContestProblems(c.id, "0"))[0].user_status,
    "attempted",
  );
  const failure = await receipt(c, p, 3, null, "SE", false);
  result = await getContestRankingView(c.id, "ioi", false, "0");
  assertEquals(result.rows[0].problem_scores[0].best_score, null);
  assertEquals(result.rows[0].pending, true);
  await getDb().delete(submissions).where(eq(submissions.id, failure.id));
  // 平台重测失败不抹去同一提交已有正式判定。
  const failedRejudge = crypto.randomUUID();
  await getDb().insert(evaluationAttempts).values({
    id: failedRejudge,
    submission_id: latest.id,
    problem_id: p.id,
    problem_version_id: p.version,
    sequence: 1,
    source: "rejudge",
    state: "error",
    result_kind: "platform_error",
    result_status: "SE",
    created_at: new Date().toISOString(),
  });
  await getDb().update(submissions).set({ latest_attempt_id: failedRejudge })
    .where(eq(submissions.id, latest.id));
  assertEquals(
    (await getContestRankingView(c.id, "ioi", false, "0")).rows[0].total_score,
    1000,
  );
  await getDb().update(submissions).set({ latest_attempt_id: latest.attempt })
    .where(eq(submissions.id, latest.id));
  await getDb().update(contests).set({
    end_time: new Date(c.base + 240_000).toISOString(),
  }).where(eq(contests.id, c.id));
  const snapshot = await publishContestRankingSnapshot(c.id, "0");
  assertEquals(snapshot.rows[0].total_score, 1000);
  assertEquals(
    snapshot.rows[0].problem_scores[0].effective_attempt_id,
    latest.attempt,
  );
  await getDb().update(evaluationAttempts).set({ score: 8000 }).where(
    eq(evaluationAttempts.id, latest.attempt),
  );
  result = await getContestRankingView(c.id, "ioi", false, "0");
  assertEquals(result.view, "official");
  assertEquals(result.rows[0].total_score, 1000);
  await assertRejects(
    () => publishContestRankingSnapshot(c.id, "0"),
    ConflictError,
  );
  const republished = await publishContestRankingSnapshot(
    c.id,
    "0",
    "复核重测结果",
  );
  assertEquals(republished.version, 2);
  assertEquals(republished.rows[0].total_score, 4000);
});

Deno.test("赛制规则：创建及编辑拒绝错误题型，开赛后冻结赛制配置", async () => {
  const oi = await problem("oi", 978002), ai = await problem("ai", 978003);
  await assertRejects(() => contest("kaggle", oi), BadRequestError);
  await assertRejects(() => contest("oi", ai), BadRequestError);
  const future = await createContest(
    {
      title: "赛前改赛制",
      type: "kaggle",
      kind: "public",
      start_time: new Date(Date.now() + 60_000).toISOString(),
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      problems: [{
        problem_id: ai.id,
        score: 10000,
        label: "A",
        sort_order: 0,
      }],
    },
    "0",
    true,
  );
  await assertRejects(
    () => updateContest(future.id, { type: "oi" }, true),
    BadRequestError,
  );
  const c = await contest("ioi_strict", oi);
  await assertRejects(() =>
    updateContest(c.id, {
      problems: [
        { problem_id: ai.id, score: 10000, label: "A", sort_order: 0 },
      ],
    }, true), BadRequestError);
  await assertRejects(
    () => updateContest(c.id, { type: "acm" }, true),
    ConflictError,
  );
  await assertRejects(
    () => updateContest(c.id, { config: { submission_limits: {} } }, true),
    ConflictError,
  );
  const hidden = await contest("oi", oi);
  await assertRejects(
    () => getContestRankingView(hidden.id, "oi", false, "0"),
    NotFoundError,
  );
});

Deno.test("ACM 榜单：CE 不计罚、首 AC、封榜 pending 及短赛默认整场封榜", async () => {
  const p = await problem("oi", 978004), c = await contest("acm", p);
  await receipt(c, p, 1, 0);
  await receipt(c, p, 2, 0, "CE");
  await receipt(c, p, 3, 0);
  await receipt(c, p, 4, 10000, "AC");
  await receipt(c, p, 5, 0);
  const result = await getContestRankingView(c.id, "acm", false, "0");
  assertEquals(result.rows[0].solved, 1);
  assertEquals(result.rows[0].penalty_ms, 44 * 60_000);
  await getDb().update(contests).set({
    freeze_start_time: new Date(c.base + 210_000).toISOString(),
  }).where(eq(contests.id, c.id));
  const frozen = await getContestRankingView(c.id, "acm", false, "0");
  assertEquals(frozen.view, "frozen");
  assertEquals(frozen.rows[0].solved, 0);
  assertEquals(frozen.rows[0].problem_scores[0].pending, true);
  assertEquals(frozen.rows[0].problem_scores[0].accepted, false);
  const short = await createContest(
    {
      title: "short",
      type: "acm",
      kind: "public",
      start_time: new Date(Date.now() + 60_000).toISOString(),
      end_time: new Date(Date.now() + 1_860_000).toISOString(),
      problems: [{ problem_id: p.id, score: 10000, label: "A", sort_order: 0 }],
    },
    "0",
    true,
  );
  assertEquals(short.freeze_duration_seconds, 1800);
});

Deno.test("OI 读取：详情、本人列表和结果筛选不能泄露赛时成绩", async () => {
  const p = await problem("oi", 978006), c = await contest("oi", p);
  const user = crypto.randomUUID(), now = new Date().toISOString();
  await getDb().insert(users).values({
    id: user,
    username: user,
    email: `${user}@example.com`,
    created_at: now,
    updated_at: now,
  });
  await getDb().insert(domainMemberships).values({
    id: crypto.randomUUID(),
    domain_id: DEFAULT_DOMAIN_ID,
    user_id: user,
    joined_at: now,
  });
  await addParticipants(c.id, [user]);
  const accepted = await receipt(c, p, 1, 10000, "AC", true, user);
  const detail = await getSubmission(accepted.id, user);
  assertEquals(detail.status, "submitted");
  assertEquals(detail.code, "code");
  assertEquals(detail.result, undefined);
  assertEquals(detail.attempts, undefined);
  const list = await listSubmissions({ userId: user, page: 1, perPage: 20 });
  assertEquals(list.total, 1);
  assertEquals(list.data[0].status, "submitted");
  assertEquals(list.data[0].result, undefined);
  assertEquals(
    (await getContestProblems(c.id, user))[0].user_status,
    "attempted",
  );
  const acceptedFilter = await listSubmissions({
    userId: user,
    acceptedOnly: true,
    page: 1,
    perPage: 20,
  });
  assertEquals(acceptedFilter.total, 0);
  assertEquals(
    (await getSubmission(accepted.id, "0", "admin")).result?.score,
    10000,
  );
});

Deno.test("客观题计分：Kaggle 与 OI 直接相加原始百分制分，不乘题目权重", async () => {
  const p = await problem("objective", 978007), db = getDb();
  for (const type of ["kaggle", "oi"] as const) {
    const c = await contest(type, p),
      id = crypto.randomUUID(),
      attempt = crypto.randomUUID();
    await db.insert(objectiveSubmissions).values({
      id,
      user_id: "0",
      paper_id: p.id,
      ...await problemExecutionForTest(p.id),
      contest_id: c.id,
      submission_type: "contest",
      answers: {},
      score: 8500,
      submitted_version_id: p.version,
      version_origin: "known",
      created_at: new Date(c.base + 60_000).toISOString(),
    });
    await db.insert(evaluationAttempts).values({
      id: attempt,
      objective_submission_id: id,
      problem_id: p.id,
      problem_version_id: p.version,
      sequence: 0,
      source: "initial",
      state: "finished",
      result_kind: "graded",
      result_status: "finished",
      score: 8500,
      accepted: false,
      created_at: new Date().toISOString(),
    });
    await db.update(objectiveSubmissions).set({
      contest_effective_attempt_id: attempt,
      is_contest_valid: true,
      latest_attempt_id: attempt,
    }).where(eq(objectiveSubmissions.id, id));
    const result = await getContestRankingView(c.id, type, true, "0");
    assertEquals(result.rows[0].total_score, 8500);
  }
  await assertRejects(() => contest("ioi", p), BadRequestError);
  await assertRejects(() => contest("acm", p), BadRequestError);
});

Deno.test("受理序号：普通提交与客观题共用数据库序列", async () => {
  const p = await problem("objective", 978005),
    db = getDb(),
    now = new Date().toISOString();
  const [first] = await db.insert(submissions).values({
    id: crypto.randomUUID(),
    user_id: "0",
    problem_id: p.id,
    ...await problemExecutionForTest(p.id),
    language: "python3",
    code: "first",
    created_at: now,
  }).returning();
  const [second] = await db.insert(objectiveSubmissions).values({
    id: crypto.randomUUID(),
    user_id: "0",
    paper_id: p.id,
    ...await problemExecutionForTest(p.id),
    submission_type: "practice",
    answers: {},
    created_at: now,
  }).returning();
  assertEquals(second.receipt_sequence > first.receipt_sequence, true);
});
