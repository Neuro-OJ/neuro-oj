/**
 * 用户升级任务受理测试（Handbook §4.4）。
 *
 * 覆盖：最新版在受理时固定、ALREADY_LATEST 跳过、source_contest 用竞赛固定版本、
 * 跨用户升级 403、500 条上限、幂等键、源已删除 / 正在评测跳过、
 * 客观题竞赛提交可升级为练习、任务读取权限。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  contestProblems,
  contests,
  objectiveSubmissions,
  problems,
  problemVersions,
  submissionJobItems,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  acceptUpgradeJob,
  getUpgradeJobForActor,
} from "../../services/versioning/upgrade-jobs.ts";

const now = new Date().toISOString();

for (const id of ["up-user-a", "up-user-b"]) {
  await getDb().insert(users).values({
    id,
    username: id,
    email: `${id}@test.noj`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
}

async function seedProblem(problemId: string, number: number): Promise<void> {
  const db = getDb();
  await db.insert(problems).values({
    id: problemId,
    title: problemId,
    description: "d",
    type: "P",
    number,
    owner_id: "0",
    judge_type: "dual",
    created_at: now,
    updated_at: now,
  });
  for (const version of [1, 2]) {
    await db.insert(problemVersions).values({
      id: `${problemId}-v${version}`,
      problem_id: problemId,
      version,
      origin: "published",
      content: { kind: "ai", title: problemId },
      published_at: now,
    });
  }
  await db.update(problems).set({ latest_version_id: `${problemId}-v2` })
    .where(eq(problems.id, problemId));
}

async function seedSubmission(
  id: string,
  problemId: string,
  options: {
    userId?: string;
    versionId?: string | null;
    contestId?: string | null;
    activeAttemptId?: string | null;
  } = {},
): Promise<void> {
  await getDb().insert(submissions).values({
    id,
    user_id: options.userId ?? "up-user-a",
    problem_id: problemId,
    contest_id: options.contestId ?? null,
    language: "python",
    code: "x",
    submitted_version_id: options.versionId === undefined
      ? `${problemId}-v1`
      : options.versionId,
    version_origin: options.versionId === null ? "legacy_unknown" : "known",
    active_attempt_id: options.activeAttemptId ?? null,
    created_at: now,
  });
}

Deno.test("upgrade: 受理时固定最新版并记录 skipped 原因", async () => {
  const db = getDb();
  await seedProblem("up-p1", 995001);
  await seedProblem("up-p2", 995002);
  // 已在最新版（v2）→ ALREADY_LATEST
  await seedSubmission("up-s-latest", "up-p2", { versionId: "up-p2-v2" });
  // 旧版 v1 → 可升级
  await seedSubmission("up-s-old", "up-p1", { versionId: "up-p1-v1" });

  const accepted = await acceptUpgradeJob(
    "up-user-a",
    {
      submissions: [
        { kind: "submission", id: "up-s-old" },
        { kind: "submission", id: "up-s-latest" },
        { kind: "submission", id: "up-s-old" }, // 重复：受理时去重
      ],
    },
    "up-key-1",
  );
  assertEquals(accepted.total_items, 2);
  assertEquals(accepted.skipped_items, 1);

  const items = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, accepted.job_id),
  ).orderBy(submissionJobItems.ordinal);
  assertEquals(items[0].source_id, "up-s-old");
  assertEquals(items[0].target_version_id, "up-p1-v2");
  assertEquals(items[0].status, "pending");
  assertEquals(items[1].status, "skipped");
  assertEquals(items[1].reason_code, "ALREADY_LATEST");

  // 受理后发布 V3：条目目标版本不变
  await db.insert(problemVersions).values({
    id: "up-p1-v3",
    problem_id: "up-p1",
    version: 3,
    origin: "published",
    content: { kind: "ai", title: "up-p1" },
    published_at: now,
  });
  await db.update(problems).set({ latest_version_id: "up-p1-v3" }).where(
    eq(problems.id, "up-p1"),
  );
  const after = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, accepted.job_id),
  ).orderBy(submissionJobItems.ordinal);
  assertEquals(after[0].target_version_id, "up-p1-v2");
});

Deno.test("upgrade: source_contest 使用竞赛固定作答版本", async () => {
  const db = getDb();
  await seedProblem("up-p3", 995003);
  await db.insert(contests).values({
    id: "up-c3",
    public_id: "ct-up3",
    title: "c",
    start_time: "2026-01-01T00:00:00.000Z",
    end_time: "2026-12-31T00:00:00.000Z",
    type: "kaggle",
    kind: "public",
    is_public: true,
    created_at: now,
    updated_at: now,
  });
  await db.insert(contestProblems).values({
    contest_id: "up-c3",
    problem_id: "up-p3",
    label: "A",
    score: 100,
    sort_order: 0,
    pinned_version_id: "up-p3-v1",
  });
  await seedSubmission("up-s-contest", "up-p3", {
    versionId: "up-p3-v1",
    contestId: "up-c3",
  });

  // 练习上下文 → 最新版 v2
  const practice = await acceptUpgradeJob(
    "up-user-a",
    {
      submissions: [{ kind: "submission", id: "up-s-contest" }],
      context: "practice",
    },
    "up-key-2",
  );
  const [practiceItem] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, practice.job_id),
  );
  assertEquals(practiceItem.target_version_id, "up-p3-v2");

  // 竞赛上下文 → 固定版 v1（与源相同 → ALREADY_LATEST）
  const contest = await acceptUpgradeJob(
    "up-user-a",
    {
      submissions: [{ kind: "submission", id: "up-s-contest" }],
      context: "source_contest",
    },
    "up-key-3",
  );
  assertEquals(contest.skipped_items, 1);
  const [contestItem] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, contest.job_id),
  );
  assertEquals(contestItem.reason_code, "ALREADY_LATEST");
});

Deno.test("upgrade: 竞赛固定版本与最新版不同且源在旧版 → 目标为固定版", async () => {
  const db = getDb();
  await seedProblem("up-p4", 995004);
  await db.insert(contests).values({
    id: "up-c4",
    public_id: "ct-up4",
    title: "c",
    start_time: "2026-01-01T00:00:00.000Z",
    end_time: "2026-12-31T00:00:00.000Z",
    type: "kaggle",
    kind: "public",
    is_public: true,
    created_at: now,
    updated_at: now,
  });
  // 竞赛固定在 v1，但题目最新版是 v2；源提交未记录版本（历史）→ 目标 = v1
  await db.insert(contestProblems).values({
    contest_id: "up-c4",
    problem_id: "up-p4",
    label: "A",
    score: 100,
    sort_order: 0,
    pinned_version_id: "up-p4-v1",
  });
  await seedSubmission("up-s-legacy", "up-p4", {
    versionId: null,
    contestId: "up-c4",
  });
  const accepted = await acceptUpgradeJob(
    "up-user-a",
    {
      submissions: [{ kind: "submission", id: "up-s-legacy" }],
      context: "source_contest",
    },
    "up-key-4",
  );
  const [item] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, accepted.job_id),
  );
  assertEquals(item.target_version_id, "up-p4-v1");
  assertEquals(item.target_version_ref, "up-p4-v1");
  assertEquals(item.status, "pending");
});

Deno.test("upgrade: 跨用户升级被拒（403）", async () => {
  await seedProblem("up-p5", 995005);
  await seedSubmission("up-s-other", "up-p5", { userId: "up-user-b" });
  await assertRejects(
    () =>
      acceptUpgradeJob(
        "up-user-a",
        { submissions: [{ kind: "submission", id: "up-s-other" }] },
        "up-key-5",
      ),
    Error,
    "只能升级自己的提交",
  );
});

Deno.test("upgrade: 源已删除与正在评测分别跳过", async () => {
  const db = getDb();
  await seedProblem("up-p6", 995006);
  await seedSubmission("up-s-judging", "up-p6", {
    activeAttemptId: null,
  });
  // 人为置为“正在评测”
  await db.update(submissions).set({ active_attempt_id: null }).where(
    eq(submissions.id, "up-s-judging"),
  );
  const accepted = await acceptUpgradeJob(
    "up-user-a",
    {
      submissions: [
        { kind: "submission", id: "up-s-judging" },
        { kind: "submission", id: "up-s-deleted" },
      ],
    },
    "up-key-6",
  );
  const items = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, accepted.job_id),
  ).orderBy(submissionJobItems.ordinal);
  assertEquals(items[0].status, "pending");
  assertEquals(items[1].status, "skipped");
  assertEquals(items[1].reason_code, "SOURCE_DELETED");
  // 保留原始引用用于解释
  assertEquals(items[1].source_id, "up-s-deleted");
});

Deno.test("upgrade: 客观题竞赛提交可升级为练习（新提交仍是练习）", async () => {
  const db = getDb();
  await seedProblem("up-p7", 995007);
  await db.update(problems).set({ is_objective: true }).where(
    eq(problems.id, "up-p7"),
  );
  await db.insert(contests).values({
    id: "up-c7",
    public_id: "ct-up7",
    title: "c",
    start_time: "2026-01-01T00:00:00.000Z",
    end_time: "2026-12-31T00:00:00.000Z",
    type: "kaggle",
    kind: "public",
    is_public: true,
    created_at: now,
    updated_at: now,
  });
  await db.insert(contestProblems).values({
    contest_id: "up-c7",
    problem_id: "up-p7",
    label: "A",
    score: 100,
    sort_order: 0,
    pinned_version_id: "up-p7-v1",
  });
  await db.insert(objectiveSubmissions).values({
    id: "up-o7",
    paper_id: "up-p7",
    user_id: "up-user-a",
    contest_id: "up-c7",
    submission_type: "contest",
    answers: { k1: ["A"] },
    status: "finished",
    score: 0,
    details: {},
    submitted_version_id: "up-p7-v1",
    version_origin: "known",
    created_at: now,
  });
  const accepted = await acceptUpgradeJob(
    "up-user-a",
    {
      submissions: [{ kind: "objective", id: "up-o7" }],
      context: "practice",
    },
    "up-key-7",
  );
  const [item] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, accepted.job_id),
  );
  assertEquals(item.source_kind, "objective");
  assertEquals(item.target_version_id, "up-p7-v2");
});

Deno.test("upgrade: 幂等键与 500 条上限", async () => {
  await seedProblem("up-p8", 995008);
  await seedSubmission("up-s-idem", "up-p8");
  const first = await acceptUpgradeJob(
    "up-user-a",
    { submissions: [{ kind: "submission", id: "up-s-idem" }] },
    "up-key-8",
  );
  const repeat = await acceptUpgradeJob(
    "up-user-a",
    { submissions: [{ kind: "submission", id: "up-s-idem" }] },
    "up-key-8",
  );
  assertEquals(repeat.existing, true);
  assertEquals(repeat.job_id, first.job_id);

  await assertRejects(
    () =>
      acceptUpgradeJob(
        "up-user-a",
        {
          submissions: [{ kind: "submission", id: "up-s-idem" }],
          context: "source_contest",
        },
        "up-key-8",
      ),
    Error,
    "已用于不同的请求",
  );

  const many = Array.from({ length: 501 }, (_, index) => ({
    kind: "submission" as const,
    id: `ghost-${index}`,
  }));
  await assertRejects(
    () => acceptUpgradeJob("up-user-a", { submissions: many }, "up-key-9"),
    Error,
    "不得超过 500 条",
  );
});

Deno.test("upgrade: 任务读取权限（本人可见 / 他人 403 / 管理员可见）", async () => {
  await seedProblem("up-p9", 995009);
  await seedSubmission("up-s-read", "up-p9");
  const accepted = await acceptUpgradeJob(
    "up-user-a",
    { submissions: [{ kind: "submission", id: "up-s-read" }] },
    "up-key-10",
  );
  const own = await getUpgradeJobForActor(accepted.job_id, "up-user-a");
  assertEquals(own?.items.length, 1);
  assertEquals(own?.context, "practice");

  await assertRejects(
    () => getUpgradeJobForActor(accepted.job_id, "up-user-b"),
    Error,
    "无权读取该任务",
  );
  const admin = await getUpgradeJobForActor(
    accepted.job_id,
    "up-user-b",
    true,
  );
  assertEquals(admin?.id, accepted.job_id);
});
