/**
 * 批任务条目关联与结算门禁查询回归（tracking #35、#46）。
 *
 * - #35「发送消息前持久化条目关联，防结果先到」：`ensureJobAttempt` 必须在同一个
 *   事务里写「尝试 + 条目 `attempt_id` + 源 `active_attempt_id`」，此时条目仍为
 *   `preparing`（消息尚未发送）；结果先到时条目进入终态，之后 `markJobItemDispatched`
 *   不得把终态改回 `dispatched`。
 * - #46「结算需检查尚未启动的批任务条目」：`listOpenJobItemsForSources` /
 *   `hasOpenJobItemsForSources` 必须查得到 `pending`（还没有 `attempt_id`）的条目，
 *   即 `queued`/`preparing` 阶段尚未创建尝试的批任务也进入结算门禁。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  problems,
  problemVersions,
  submissionJobItems,
  submissionJobs,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  claimJobItems,
  hasOpenJobItemsForSources,
  listOpenJobItemsForSources,
  markJobItemDispatched,
} from "../../services/versioning/job-worker.ts";
import { ensureJobAttempt } from "../../services/versioning/job-attempt.ts";
import type { DispatchSource } from "../../services/versioning/dispatch-job-item.ts";
import { applyAttemptResult } from "../../services/versioning/result-write.ts";
import type { SubmissionJobItemStatus } from "../../../../shared/versioning/types.ts";

const now = new Date().toISOString();
const db = getDb();

await db.insert(users).values({
  id: "oi-user",
  username: "oi-user",
  email: "oi-user@test.noj",
  password_hash: "hash",
  created_at: now,
  updated_at: now,
});

const dualConfig = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 1000,
    memory_limit_mb: 256,
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 1000,
    memory_limit_mb: 256,
  },
};

const aiContent = {
  kind: "ai",
  title: "题",
  description: "d",
  samples: [],
  submission_mode: "code",
  runtime_config: dualConfig,
  template_content: "",
  artifact_max_size_mb: null,
  llm_config: null,
} as never;

async function seedProblem(problemId: string): Promise<string> {
  const versionId = `${problemId}-v1`;
  await db.insert(problems).values({
    id: problemId,
    title: problemId,
    description: "d",
    type: "P",
    number: 996500 + Math.floor(Math.random() * 1000),
    owner_id: "0",
    judge_type: "dual",
    created_at: now,
    updated_at: now,
  });
  await db.insert(problemVersions).values({
    id: versionId,
    problem_id: problemId,
    version: 1,
    origin: "published",
    content: aiContent,
    published_at: now,
  });
  await db.update(problems).set({ latest_version_id: versionId }).where(
    eq(problems.id, problemId),
  );
  return versionId;
}

async function seedJob(jobId: string): Promise<void> {
  await db.insert(submissionJobs).values({
    id: jobId,
    kind: "rejudge",
    actor_id: "oi-user",
    idempotency_key: `key-${jobId}`,
    request_hash: "h",
    request: {},
    status: "queued",
    created_at: now,
  });
}

async function seedItem(input: {
  id: string;
  jobId: string;
  sourceId: string;
  problemId: string;
  sourceKind?: "submission" | "objective";
  status?: SubmissionJobItemStatus;
  targetVersionId?: string | null;
  ordinal?: number;
}): Promise<void> {
  await db.insert(submissionJobItems).values({
    id: input.id,
    job_id: input.jobId,
    ordinal: input.ordinal ?? 0,
    source_kind: input.sourceKind ?? "submission",
    source_id: input.sourceId,
    problem_id: input.problemId,
    target_version_id: input.targetVersionId ?? null,
    target_version_ref: input.targetVersionId ?? null,
    status: input.status ?? "pending",
    created_at: now,
  });
}

Deno.test("open-items#46: 查询覆盖 pending/preparing/dispatched，排除终态", async () => {
  await seedProblem("oi-p1");
  await seedJob("oi-job-1");
  // pending 且**还没有 attempt_id**（queued 阶段尚未创建尝试）——必须被查到
  await seedItem({
    id: "oi-i1",
    jobId: "oi-job-1",
    sourceId: "oi-s1",
    problemId: "oi-p1",
    ordinal: 0,
  });
  await seedItem({
    id: "oi-i2",
    jobId: "oi-job-1",
    sourceId: "oi-s2",
    problemId: "oi-p1",
    status: "preparing",
    ordinal: 1,
  });
  await seedItem({
    id: "oi-i3",
    jobId: "oi-job-1",
    sourceId: "oi-s3",
    problemId: "oi-p1",
    status: "dispatched",
    ordinal: 2,
  });
  await seedItem({
    id: "oi-i4",
    jobId: "oi-job-1",
    sourceId: "oi-s4",
    problemId: "oi-p1",
    status: "succeeded",
    ordinal: 3,
  });
  await seedItem({
    id: "oi-i5",
    jobId: "oi-job-1",
    sourceId: "oi-s5",
    problemId: "oi-p1",
    status: "failed",
    ordinal: 4,
  });
  await seedItem({
    id: "oi-i6",
    jobId: "oi-job-1",
    sourceId: "oi-s6",
    problemId: "oi-p1",
    status: "skipped",
    ordinal: 5,
  });
  await seedItem({
    id: "oi-i7",
    jobId: "oi-job-1",
    sourceId: "oi-o1",
    problemId: "oi-p1",
    sourceKind: "objective",
    status: "pending",
    ordinal: 6,
  });

  const open = await listOpenJobItemsForSources([
    { kind: "submission", id: "oi-s1" },
    { kind: "submission", id: "oi-s2" },
    { kind: "submission", id: "oi-s3" },
    { kind: "submission", id: "oi-s4" },
    { kind: "submission", id: "oi-s5" },
    { kind: "submission", id: "oi-s6" },
    { kind: "objective", id: "oi-o1" },
  ]);
  assertEquals(open.map((row) => row.item_id).sort(), [
    "oi-i1",
    "oi-i2",
    "oi-i3",
    "oi-i7",
  ]);

  // 只查有终态条目的源 → 空
  assertEquals(
    await listOpenJobItemsForSources([{ kind: "submission", id: "oi-none" }]),
    [],
  );
  assertEquals(await hasOpenJobItemsForSources([]), false);
  assertEquals(
    await hasOpenJobItemsForSources([{ kind: "submission", id: "oi-s1" }]),
    true,
  );

  // 条目标记终态后不再计入
  await db.update(submissionJobItems).set({
    status: "succeeded",
    finished_at: now,
  }).where(eq(submissionJobItems.id, "oi-i1"));
  await db.update(submissionJobItems).set({
    status: "succeeded",
    finished_at: now,
  }).where(eq(submissionJobItems.id, "oi-i2"));
  assertEquals(
    await hasOpenJobItemsForSources([
      { kind: "submission", id: "oi-s1" },
      { kind: "submission", id: "oi-s2" },
    ]),
    false,
  );
  // 仍在途的源单独判定为 true，题型不同的源互不干扰
  assertEquals(
    await hasOpenJobItemsForSources([{ kind: "submission", id: "oi-s3" }]),
    true,
  );
  assertEquals(
    (await listOpenJobItemsForSources([{ kind: "objective", id: "oi-o1" }]))
      .length,
    1,
  );
});

Deno.test("dispatch#35: 派发前持久化条目关联，结果先到后派发写入不回退终态", async () => {
  const versionId = await seedProblem("oi-p2");
  await db.insert(submissions).values({
    id: "oi-source",
    user_id: "oi-user",
    problem_id: "oi-p2",
    language: "python",
    code: "print(1)",
    submitted_version_id: versionId,
    version_origin: "known",
    created_at: now,
  });
  await seedJob("oi-job-2");
  await seedItem({
    id: "oi-item-2",
    jobId: "oi-job-2",
    sourceId: "oi-source",
    problemId: "oi-p2",
    targetVersionId: versionId,
  });

  const owner = "worker-a";
  const [claimed] = await claimJobItems(owner, { limit: 1 });
  assertEquals(claimed.id, "oi-item-2");
  assertEquals(claimed.attempt_id, null);

  const source: DispatchSource = {
    id: "oi-source",
    problem_id: "oi-p2",
    user_id: "oi-user",
    language: "python",
    code: "print(1)",
    file_name: null,
    contest_id: null,
    active_attempt_id: null,
    artifact_storage_url: null,
    submitted_version_id: versionId,
    answers: null,
  };

  // 创建尝试：条目 attempt_id 与源 active_attempt_id 必须在**同一事务**里落库，
  // 且此刻条目仍是 preparing（MQ 消息尚未发送）
  const attempt = await ensureJobAttempt({
    item: claimed,
    owner,
    source,
    content: aiContent,
    kind: "rejudge",
  });
  const [bound] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.id, "oi-item-2"),
  );
  assertEquals(bound.attempt_id, attempt.id);
  assertEquals(bound.status, "preparing");
  const [sourceRow] = await db.select().from(submissions).where(
    eq(submissions.id, "oi-source"),
  );
  assertEquals(sourceRow.active_attempt_id, attempt.id);

  // 结果「早于」派发状态写入到达：条目立即进入终态
  const outcome = await applyAttemptResult({
    attemptId: attempt.id,
    resultKind: "graded",
    resultStatus: "finished",
    score: 10000,
    accepted: true,
  });
  assertEquals(outcome.applied, "graded");
  const [done] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.id, "oi-item-2"),
  );
  assertEquals(done.status, "succeeded");

  // 迟到的派发状态写入不得把终态改回 dispatched
  assertEquals(
    await markJobItemDispatched("oi-item-2", attempt.id, owner),
    false,
  );
  const [after] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.id, "oi-item-2"),
  );
  assertEquals(after.status, "succeeded");
  // 无重复尝试
  const attempts = await db.select().from(evaluationAttempts).where(
    eq(evaluationAttempts.submission_id, "oi-source"),
  );
  assertEquals(attempts.length, 1);
});
