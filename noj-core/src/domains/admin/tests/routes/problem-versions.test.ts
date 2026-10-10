/**
 * 有效版本策略与竞赛固定版本 HTTP 路由测试（Handbook §4.5）。
 *
 * 覆盖：
 * - 题库策略切换（any ↔ exact(X)）要求预期 revision；过时 revision → 409；
 * - 非法 policy / expected_revision → 400；
 * - 竞赛策略切换：`exact(X)` 同时把固定作答版本设为 X；
 * - 单独升级固定版本：与现有 exact 策略冲突且未同时给策略 → 409，
 *   同一请求带上新策略则通过；
 * - 非管理员访问一律 403。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  contestProblems,
  contests,
  problems,
  problemVersions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
} from "../../../../../tests/helper.ts";
import { createContest } from "../../../contest/index.ts";

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

/** 建题 + 两个已发布版本（最新版指向 V2）。 */
async function seedProblem(tag: string): Promise<{
  problemId: string;
  v1: string;
  v2: string;
}> {
  const problemId = `tst-pol-prob-${tag}-${ts}`;
  await db.insert(problems).values({
    id: problemId,
    title: `策略路由题 ${tag}`,
    description: "d",
    difficulty: "easy",
    type: "P",
    number: 97000 + Math.floor(Math.random() * 900),
    owner_id: "0",
    judge_type: "dual",
    runtime_config: runtimeConfig,
    created_at: now,
    updated_at: now,
  });
  const v1 = `${problemId}-v1`;
  const v2 = `${problemId}-v2`;
  await db.insert(problemVersions).values([
    {
      id: v1,
      problem_id: problemId,
      version: 1,
      origin: "published",
      content: {
        kind: "ai",
        title: `策略路由题 ${tag}`,
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: runtimeConfig,
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      published_at: now,
    },
    {
      id: v2,
      problem_id: problemId,
      version: 2,
      origin: "published",
      content: {
        kind: "ai",
        title: `策略路由题 ${tag}`,
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: runtimeConfig,
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      published_at: now,
    },
  ]);
  await db.update(problems).set({ latest_version_id: v2 }).where(
    eq(problems.id, problemId),
  );
  return { problemId, v1, v2 };
}

Deno.test({
  name: "problem versions route: 题库策略切换的乐观锁与参数校验",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const adminToken = await createUserToken("admin");
    const { problemId, v1 } = await seedProblem("lib");
    const url = `/api/v1/admin/problems/${problemId}/effective-version-policy`;

    // 非法 policy.mode → 400
    const badMode = await jsonRequest(app, url, {
      method: "PUT",
      token: adminToken,
      body: { policy: { mode: "bogus" }, expected_revision: 0 },
    });
    assertEquals(badMode.status, 400);

    // exact 缺 version_id → 400
    const badExact = await jsonRequest(app, url, {
      method: "PUT",
      token: adminToken,
      body: { policy: { mode: "exact" }, expected_revision: 0 },
    });
    assertEquals(badExact.status, 400);

    // expected_revision 缺失 → 400（乐观锁必填）
    const badRevision = await jsonRequest(app, url, {
      method: "PUT",
      token: adminToken,
      body: { policy: { mode: "any" } },
    });
    assertEquals(badRevision.status, 400);

    // 正常切换为 exact(V1)
    const switched = await jsonRequest(app, url, {
      method: "PUT",
      token: adminToken,
      body: { policy: { mode: "exact", version_id: v1 }, expected_revision: 0 },
    });
    assertEquals(switched.status, 200);
    const switchedBody = await switched.json();
    assertEquals(switchedBody.data.policy, { mode: "exact", version_id: v1 });
    assertEquals(switchedBody.data.revision, 1);
    const [row] = await db.select({
      mode: problems.effective_version_mode,
      required: problems.required_version_id,
      latest: problems.latest_version_id,
    }).from(problems).where(eq(problems.id, problemId));
    assertEquals(row.mode, "exact");
    assertEquals(row.required, v1);
    // exact 不修改最新版指针（§1.2）
    assertEquals(row.latest, `${problemId}-v2`);

    // 过时 revision → 409
    const stale = await jsonRequest(app, url, {
      method: "PUT",
      token: adminToken,
      body: { policy: { mode: "any" }, expected_revision: 0 },
    });
    assertEquals(stale.status, 409);
    assertEquals(
      (await stale.json()).code,
      "EFFECTIVE_POLICY_REVISION_CONFLICT",
    );

    // 用新 revision 切回 any → 成功
    const backToAny = await jsonRequest(app, url, {
      method: "PUT",
      token: adminToken,
      body: { policy: { mode: "any" }, expected_revision: 1 },
    });
    assertEquals(backToAny.status, 200);
    assertEquals((await backToAny.json()).data.revision, 2);

    // 非管理员 → 403
    const userToken = await createUserToken("user");
    const forbidden = await jsonRequest(app, url, {
      method: "PUT",
      token: userToken,
      body: { policy: { mode: "any" }, expected_revision: 2 },
    });
    assertEquals(forbidden.status, 403);
  },
});

Deno.test({
  name: "problem versions route: 竞赛策略与固定版本升级的相互作用",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const adminToken = await createUserToken("admin");
    const { problemId, v1, v2 } = await seedProblem("contest");

    // 用竞赛服务创建竞赛（自动把题目固定在当时的最新版 V2），避免手工拼装关联
    const creatorId = crypto.randomUUID();
    await db.insert(users).values({
      id: creatorId,
      username: `tstpol-creator-${creatorId.slice(0, 8)}`,
      email: `${creatorId}@test.noj`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    });
    const contest = await createContest({
      title: "策略路由竞赛",
      start_time: new Date(Date.now() + 60_000).toISOString(),
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      type: "kaggle",
      password: "ContestPass123",
      problems: [{
        problem_id: problemId,
        label: "A",
        sort_order: 0,
        score: 10000,
      }],
    }, creatorId);
    const contestId = contest.id;

    const policyUrl =
      `/api/v1/admin/contests/${contestId}/problems/${problemId}/effective-version-policy`;
    const versionUrl =
      `/api/v1/admin/contests/${contestId}/problems/${problemId}/version`;

    // 竞赛 exact(V1)：固定作答版本同步变为 V1（§1.2）
    const exact = await jsonRequest(app, policyUrl, {
      method: "PUT",
      token: adminToken,
      body: { policy: { mode: "exact", version_id: v1 }, expected_revision: 0 },
    });
    assertEquals(exact.status, 200);
    const [pinned] = await db.select({
      pinned: contestProblems.pinned_version_id,
      mode: contestProblems.effective_version_mode,
    }).from(contestProblems).where(
      and(
        eq(contestProblems.contest_id, contestId),
        eq(contestProblems.problem_id, problemId),
      ),
    );
    assertEquals(pinned.pinned, v1);
    assertEquals(pinned.mode, "exact");

    // 单独升级固定版本到 V2：现有 exact(V1) 与其冲突且未同时给策略 → 409
    const conflict = await jsonRequest(app, versionUrl, {
      method: "PUT",
      token: adminToken,
      body: { version_id: v2, expected_revision: 1 },
    });
    assertEquals(conflict.status, 409);
    assertEquals(
      (await conflict.json()).code,
      "CONTEST_PROBLEM_VERSION_POLICY_CONFLICT",
    );

    // 同一请求带上新策略 → 通过，固定版本与服务端返回一致
    const upgraded = await jsonRequest(app, versionUrl, {
      method: "PUT",
      token: adminToken,
      body: {
        version_id: v2,
        policy: { mode: "any" },
        expected_revision: 1,
      },
    });
    assertEquals(upgraded.status, 200);
    const upgradedBody = await upgraded.json();
    assertEquals(upgradedBody.data.pinned_version_id, v2);
    assertEquals(upgradedBody.data.policy, { mode: "any" });
    const [after] = await db.select({
      pinned: contestProblems.pinned_version_id,
    }).from(contestProblems).where(
      and(
        eq(contestProblems.contest_id, contestId),
        eq(contestProblems.problem_id, problemId),
      ),
    );
    assertEquals(after.pinned, v2);

    // 清理：竞赛删除级联清理关联
    await db.delete(contests).where(eq(contests.id, contestId));
  },
});
