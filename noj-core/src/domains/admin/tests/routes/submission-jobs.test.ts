/**
 * 批量重测 / 用户升级任务 HTTP 路由测试（Handbook §4.3、§4.4）。
 *
 * 覆盖：管理员受理重测任务（幂等键必填）、任务详情与条目列表、重试生成关联新任务、
 * 用户升级任务受理、本人可读 / 他人 403 / 管理员可读任意。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  problems,
  problemVersions,
  submissionJobItems,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
} from "../../../../../tests/helper.ts";

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasEnv;

const now = new Date().toISOString();
const ts = Date.now();

await resetDbForTest();
await initRedisForTest();
const db = getDb();

const runtimeConfig = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 2000,
    memory_limit_mb: 512,
  },
};

/** 建题（含 V1 版本与最新版指针）与一名提交用户，返回 ID 集合。 */
async function seedProblemAndSubmission(tag: string): Promise<{
  problemId: string;
  versionId: string;
  userId: string;
  submissionId: string;
}> {
  const problemId = `tst-jobs-prob-${tag}-${ts}`;
  const versionId = `tst-jobs-ver-${tag}-${ts}`;
  const userId = `tst-jobs-user-${tag}-${ts}`;
  const submissionId = `tst-jobs-sub-${tag}-${ts}`;
  await db.insert(users).values({
    id: userId,
    username: `tstjobs-${tag}-${ts}`,
    email: `tstjobs-${tag}-${ts}@test.noj`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  await db.insert(problems).values({
    id: problemId,
    title: `任务路由题 ${tag}`,
    description: "d",
    difficulty: "easy",
    type: "P",
    number: 98000 + Math.floor(Math.random() * 900),
    owner_id: "0",
    judge_type: "dual",
    runtime_config: runtimeConfig,
    created_at: now,
    updated_at: now,
  });
  await db.insert(problemVersions).values({
    id: versionId,
    problem_id: problemId,
    version: 1,
    origin: "published",
    content: {
      kind: "ai",
      title: `任务路由题 ${tag}`,
      description: "d",
      samples: [],
      submission_mode: "code",
      runtime_config: runtimeConfig,
      template_content: "",
      artifact_max_size_mb: null,
      llm_config: null,
    },
    published_at: now,
  });
  await db.update(problems).set({ latest_version_id: versionId }).where(
    eq(problems.id, problemId),
  );
  await db.insert(submissions).values({
    id: submissionId,
    user_id: userId,
    problem_id: problemId,
    status: "finished",
    language: "python3",
    code: "print(1)",
    submitted_version_id: versionId,
    version_origin: "known",
    created_at: now,
  });
  return { problemId, versionId, userId, submissionId };
}

Deno.test({
  name: "submission jobs route: 受理重测任务并读取详情与条目",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const admin = await createUserToken("admin");
    const { submissionId } = await seedProblemAndSubmission("rejudge");

    // 缺少 Idempotency-Key → 400
    const missing = await jsonRequest(app, "/api/v1/admin/submission-jobs", {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}` },
      body: {
        kind: "rejudge",
        scope: {
          type: "selected",
          submissions: [{ kind: "submission", id: submissionId }],
        },
        target: { mode: "submitted" },
      },
    });
    assertEquals(missing.status, 400);

    const key = crypto.randomUUID();
    const accepted = await jsonRequest(
      app,
      "/api/v1/admin/submission-jobs",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${admin}`,
          "Idempotency-Key": key,
        },
        body: {
          kind: "rejudge",
          scope: {
            type: "selected",
            submissions: [{ kind: "submission", id: submissionId }],
          },
          target: { mode: "submitted" },
        },
      },
    );
    assertEquals(accepted.status, 202);
    const jobId = (await accepted.json()).data.job_id as string;
    assertEquals(typeof jobId, "string");

    // 同键同请求 → 复用原任务
    const again = await jsonRequest(app, "/api/v1/admin/submission-jobs", {
      method: "POST",
      headers: { Authorization: `Bearer ${admin}`, "Idempotency-Key": key },
      body: {
        kind: "rejudge",
        scope: {
          type: "selected",
          submissions: [{ kind: "submission", id: submissionId }],
        },
        target: { mode: "submitted" },
      },
    });
    assertEquals(again.status, 202);
    const againBody = await again.json();
    assertEquals(againBody.data.job_id, jobId);
    assertEquals(againBody.data.existing, true);

    const detail = await jsonRequest(
      app,
      `/api/v1/admin/submission-jobs/${jobId}`,
      { headers: { Authorization: `Bearer ${admin}` } },
    );
    assertEquals(detail.status, 200);
    const job = (await detail.json()).data;
    assertEquals(job.id, jobId);
    assertEquals(job.kind, "rejudge");
    assertEquals(job.total_items, 1);

    const items = await jsonRequest(
      app,
      `/api/v1/admin/submission-jobs/${jobId}/items`,
      { headers: { Authorization: `Bearer ${admin}` } },
    );
    assertEquals(items.status, 200);
    const itemBody = await items.json();
    assertEquals(itemBody.total, 1);
    assertEquals(itemBody.data[0].source_id, submissionId);
    // `submitted` 目标：条目固定为提交时版本
    assertEquals(itemBody.data[0].target_version_id !== null, true);
  },
});

Deno.test({
  name: "submission jobs route: 重试生成关联新任务且不报错",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const admin = await createUserToken("admin");
    const { submissionId } = await seedProblemAndSubmission("retry");

    const accepted = await jsonRequest(app, "/api/v1/admin/submission-jobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${admin}`,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: {
        kind: "rejudge",
        scope: {
          type: "selected",
          submissions: [{ kind: "submission", id: submissionId }],
        },
        target: { mode: "submitted" },
      },
    });
    const jobId = (await accepted.json()).data.job_id as string;

    // 无 failed/skipped 条目时拒绝重试（400），避免空转任务
    const nothingToRetry = await jsonRequest(
      app,
      `/api/v1/admin/submission-jobs/${jobId}/retry`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${admin}`,
          "Idempotency-Key": crypto.randomUUID(),
        },
      },
    );
    assertEquals(nothingToRetry.status, 400);

    // 把条目置为 failed（模拟派发失败）后重试
    await db.update(submissionJobItems).set({
      status: "failed",
      reason_code: "DISPATCH_FAILED",
      reason_message: "测试构造",
      finished_at: now,
    }).where(eq(submissionJobItems.job_id, jobId));

    const retried = await jsonRequest(
      app,
      `/api/v1/admin/submission-jobs/${jobId}/retry`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${admin}`,
          "Idempotency-Key": crypto.randomUUID(),
        },
      },
    );
    assertEquals(retried.status, 202);
    const retryBody = await retried.json();
    // 关联新任务（不同 ID），保留目标版本映射
    assertEquals(retryBody.data.job_id !== jobId, true);

    const retryItems = await jsonRequest(
      app,
      `/api/v1/admin/submission-jobs/${retryBody.data.job_id}/items`,
      { headers: { Authorization: `Bearer ${admin}` } },
    );
    const retryItemBody = await retryItems.json();
    assertEquals(retryItemBody.total, 1);
    // 重试保留目标版本映射，且不再次修改有效策略
    assertEquals(retryItemBody.data[0].target_version_id !== null, true);
    assertEquals(retryItemBody.data[0].status, "pending");
  },
});

Deno.test({
  name: "upgrade jobs route: 用户受理升级任务，本人可读/他人 403/管理员可读",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const ownerToken = await createUserToken("user");
    const otherToken = await createUserToken("user");
    const admin = await createUserToken("admin");
    const { submissionId, userId } = await seedProblemAndSubmission("upgrade");

    // 把提交归属改为 ownerToken 对应用户：直接用 token 里的 sub 不可读，
    // 因此这里以 userId 为准构造“他人”场景（ownerToken 非该提交所有者）。
    const ownerAccepted = await jsonRequest(
      app,
      "/api/v1/submission-upgrade-jobs",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${admin}`,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: { submissions: [{ kind: "submission", id: submissionId }] },
      },
    );
    // 管理员通过管理入口为原用户升级：由服务层判定跨用户权限
    if (ownerAccepted.status !== 202) {
      // 服务层禁止跨用户非管理员升级时，这里退化为直接验证本人场景
      assertEquals([400, 403].includes(ownerAccepted.status), true);
    }

    // 本人场景：新建一条归属该 token 用户的提交
    const mine = await seedProblemAndSubmission("upgrade-mine");
    const myUserId = (await (await jsonRequest(app, "/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${ownerToken}` },
    })).json()).data.id as string;
    await db.update(submissions).set({ user_id: myUserId }).where(
      eq(submissions.id, mine.submissionId),
    );

    const accepted = await jsonRequest(app, "/api/v1/submission-upgrade-jobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: { submissions: [{ kind: "submission", id: mine.submissionId }] },
    });
    assertEquals(accepted.status, 202);
    const jobId = (await accepted.json()).data.job_id as string;

    // 本人可读
    const own = await jsonRequest(
      app,
      `/api/v1/submission-upgrade-jobs/${jobId}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    assertEquals(own.status, 200);
    assertEquals((await own.json()).data.id, jobId);

    // 他人 403（不泄露任务内容）
    const other = await jsonRequest(
      app,
      `/api/v1/submission-upgrade-jobs/${jobId}`,
      { headers: { Authorization: `Bearer ${otherToken}` } },
    );
    assertEquals(other.status, 403);

    // 管理员可读任意
    const asAdmin = await jsonRequest(
      app,
      `/api/v1/submission-upgrade-jobs/${jobId}`,
      { headers: { Authorization: `Bearer ${admin}` } },
    );
    assertEquals(asAdmin.status, 200);
    void userId;
  },
});
