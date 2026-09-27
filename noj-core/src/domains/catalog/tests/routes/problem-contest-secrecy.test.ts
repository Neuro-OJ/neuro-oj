/**
 * 公开赛保密规则的路由级测试（2026-09-26）。
 *
 * 规格：题目一旦被加入**公开赛**（`contests.kind = 'public'`，邀请赛除外），
 * 除题目所有者与管理员外，所有访问题目相关页面/接口的人都拿到 404；
 * 所有者与管理员正常访问，并在响应里拿到 `contest_secrecy` 提示（前端据此渲染横幅）。
 * 竞赛 `end_time` 一过，题目自动恢复常规可见性。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { createApp } from "../../../../app.ts";
import { createProblem } from "../../index.ts";
import { createContest, deleteContest } from "../../../contest/index.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { contests, problems } from "../../../../shared/db/schema.ts";
import { createUserToken, jsonRequest } from "../../../../../tests/helper.ts";
import { initRedisForTest } from "../../../../../tests/helper.ts";

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skipEnv = !hasEnv;

await resetDbForTest();
await initRedisForTest();

/** 创建一道 public 的 U 型题，并指定 owner。 */
async function createOwnedPublicProblem(ownerId: string): Promise<string> {
  // 不带 userId 走服务端流程：绕过"敏感字段（evaluator.command）需权限"的守卫，
  // 随后再把 owner_id 落到目标用户，模拟"普通用户拥有的公开题"。
  const created = await createProblem({
    title: `保密规则路由测试题 ${Date.now()}_${
      Math.random().toString(36).slice(2, 8)
    }`,
    description: "测试描述",
    difficulty: "easy",
    type: "U",
    runtime_config: {
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
    },
  });
  // U 型默认 private，本规则只对"本应公开可见"的题设防，故显式置 public
  await getDb()
    .update(problems)
    .set({
      visibility: "public",
      owner_id: ownerId,
      updated_at: new Date().toISOString(),
    })
    .where(eq(problems.id, created.id));
  return created.id;
}

/** 把题目挂进一场指定窗口的竞赛，返回竞赛 id。 */
async function linkToContest(
  problemId: string,
  creatorId: string,
  opts: {
    startOffsetMs: number;
    endOffsetMs: number;
    kind?: "public" | "invite";
  },
): Promise<string> {
  const contest = await createContest(
    {
      title: `保密规则 ${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      start_time: new Date(Date.now() + opts.startOffsetMs).toISOString(),
      end_time: new Date(Date.now() + opts.endOffsetMs).toISOString(),
      type: "kaggle",
      problems: [{
        problem_id: problemId,
        label: "A",
        sort_order: 0,
        score: 10000,
      }],
    },
    creatorId,
    true,
  );
  if (opts.kind === "invite") {
    await getDb()
      .update(contests)
      .set({ kind: "invite" })
      .where(eq(contests.id, contest.id));
  }
  return contest.id;
}

/** 建题 + 建赛（running 窗口）+ 返回 owner token 与标识。 */
async function setupRunningPublicContest(): Promise<{
  ownerToken: string;
  problemId: string;
  contestId: string;
  contestTitle: string;
}> {
  const ownerToken = await createUserToken();
  const ownerId = decodeJwt(ownerToken).sub as string;
  const problemId = await createOwnedPublicProblem(ownerId);
  const contestId = await linkToContest(problemId, ownerId, {
    startOffsetMs: -60_000,
    endOffsetMs: 3_600_000,
  });
  const [row] = await getDb()
    .select({ title: contests.title })
    .from(contests)
    .where(eq(contests.id, contestId))
    .limit(1);
  return {
    ownerToken,
    problemId,
    contestId,
    contestTitle: row.title,
  };
}

async function cleanup(contestId: string, problemId: string): Promise<void> {
  await deleteContest(contestId).catch(() => {});
  await getDb().delete(problems).where(eq(problems.id, problemId)).catch(
    () => {},
  );
}

Deno.test({
  name: "保密规则: 关联未结束公开赛的题目对匿名 404（不泄露存在性）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const { problemId, contestId } = await setupRunningPublicContest();
    try {
      const res = await jsonRequest(app, `/api/v1/problems/${problemId}`);
      assertEquals(res.status, 404);
      assertEquals((await res.json()).error, "题目不存在");
    } finally {
      await cleanup(contestId, problemId);
    }
  },
});

Deno.test({
  name: "保密规则: 关联未结束公开赛的题目对非 owner 登录用户 404",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const { problemId, contestId } = await setupRunningPublicContest();
    const otherToken = await createUserToken();
    try {
      const res = await jsonRequest(app, `/api/v1/problems/${problemId}`, {
        token: otherToken,
      });
      assertEquals(res.status, 404);
    } finally {
      await cleanup(contestId, problemId);
    }
  },
});

Deno.test({
  name: "保密规则: 题目所有者可见，并收到 contest_secrecy 保密提示",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const { ownerToken, problemId, contestId, contestTitle } =
      await setupRunningPublicContest();
    try {
      const res = await jsonRequest(app, `/api/v1/problems/${problemId}`, {
        token: ownerToken,
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.data.id, problemId);
      assertEquals(body.data.contest_secrecy.length, 1);
      assertEquals(body.data.contest_secrecy[0].title, contestTitle);
      assertEquals(
        typeof body.data.contest_secrecy[0].public_id,
        "string",
      );
    } finally {
      await cleanup(contestId, problemId);
    }
  },
});

Deno.test({
  name: "保密规则: 管理员可见，并收到 contest_secrecy 保密提示",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const { problemId, contestId } = await setupRunningPublicContest();
    const adminToken = await createUserToken("admin");
    try {
      const res = await jsonRequest(app, `/api/v1/problems/${problemId}`, {
        token: adminToken,
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.data.contest_secrecy.length, 1);
    } finally {
      await cleanup(contestId, problemId);
    }
  },
});

Deno.test({
  name: "保密规则: 竞赛结束后题目自动恢复公开（赛后复盘/补题）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const ownerToken = await createUserToken();
    const ownerId = decodeJwt(ownerToken).sub as string;
    const problemId = await createOwnedPublicProblem(ownerId);
    const contestId = await linkToContest(problemId, ownerId, {
      startOffsetMs: -7_200_000,
      endOffsetMs: -3_600_000,
    });
    try {
      const res = await jsonRequest(app, `/api/v1/problems/${problemId}`);
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.data.contest_secrecy, undefined);
    } finally {
      await cleanup(contestId, problemId);
    }
  },
});

Deno.test({
  name: "保密规则: 邀请赛不触发保密（题目保持公开）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const ownerToken = await createUserToken();
    const ownerId = decodeJwt(ownerToken).sub as string;
    const problemId = await createOwnedPublicProblem(ownerId);
    const contestId = await linkToContest(problemId, ownerId, {
      startOffsetMs: -60_000,
      endOffsetMs: 3_600_000,
      kind: "invite",
    });
    try {
      const res = await jsonRequest(app, `/api/v1/problems/${problemId}`);
      assertEquals(res.status, 200);
    } finally {
      await cleanup(contestId, problemId);
    }
  },
});

Deno.test({
  name: "保密规则: 赛前（pending）公开赛同样保密",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const ownerToken = await createUserToken();
    const ownerId = decodeJwt(ownerToken).sub as string;
    const problemId = await createOwnedPublicProblem(ownerId);
    const contestId = await linkToContest(problemId, ownerId, {
      startOffsetMs: 3_600_000,
      endOffsetMs: 7_200_000,
    });
    try {
      assertEquals(
        (await jsonRequest(app, `/api/v1/problems/${problemId}`)).status,
        404,
      );
      // owner 仍可访问
      assertEquals(
        (await jsonRequest(app, `/api/v1/problems/${problemId}`, {
          token: ownerToken,
        })).status,
        200,
      );
    } finally {
      await cleanup(contestId, problemId);
    }
  },
});

Deno.test({
  name: "保密规则: 公开统计接口对匿名 404（不留统计侧预言机）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const { problemId, contestId } = await setupRunningPublicContest();
    try {
      const res = await jsonRequest(
        app,
        `/api/v1/problems/${problemId}/stats/public`,
      );
      assertEquals(res.status, 404);
    } finally {
      await cleanup(contestId, problemId);
    }
  },
});

Deno.test({
  name: "保密规则: starter code 模板对非 owner 404（此前无访问校验）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const { problemId, contestId } = await setupRunningPublicContest();
    const otherToken = await createUserToken();
    try {
      const res = await jsonRequest(
        app,
        `/api/v1/problems/${problemId}/template`,
        { token: otherToken },
      );
      assertEquals(res.status, 404);
    } finally {
      await cleanup(contestId, problemId);
    }
  },
});

Deno.test({
  name: "保密规则: 支持包路由对非 owner 404，且不改变既有包权限口径",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const { problemId, contestId } = await setupRunningPublicContest();
    const otherToken = await createUserToken();
    // 对照题：public 题、不属于任何竞赛（无支持包）
    const controlOwnerToken = await createUserToken();
    const controlOwnerId = decodeJwt(controlOwnerToken).sub as string;
    const controlProblemId = await createOwnedPublicProblem(controlOwnerId);
    try {
      // 保密命中：先于包权限校验返回 404「题目不存在」
      const secret = await jsonRequest(
        app,
        `/api/v1/problems/${problemId}/support-package`,
        { token: otherToken },
      );
      assertEquals(secret.status, 404);
      assertEquals((await secret.json()).error, "题目不存在");

      // 非保密题：保持既有的 403（package_manage 权限）口径
      const control = await jsonRequest(
        app,
        `/api/v1/problems/${controlProblemId}/support-package`,
        { token: otherToken },
      );
      assertEquals(control.status, 403);
    } finally {
      await cleanup(contestId, problemId);
      await getDb().delete(problems).where(eq(problems.id, controlProblemId))
        .catch(() => {});
    }
  },
});

Deno.test({
  name: "保密规则: 独立提交路径被拦（403），同形非保密题不被拦（对照）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const { problemId, contestId } = await setupRunningPublicContest();
    const otherToken = await createUserToken();
    // 对照题：同样是 public U 型题，但不属于任何竞赛
    const controlOwnerToken = await createUserToken();
    const controlOwnerId = decodeJwt(controlOwnerToken).sub as string;
    const controlProblemId = await createOwnedPublicProblem(controlOwnerId);
    try {
      const secret = await jsonRequest(app, "/api/v1/submissions", {
        method: "POST",
        token: otherToken,
        body: {
          problem_id: problemId,
          language: "python3",
          code: "print(1)",
        },
      });
      assertEquals(secret.status, 403);

      const control = await jsonRequest(app, "/api/v1/submissions", {
        method: "POST",
        token: otherToken,
        body: {
          problem_id: controlProblemId,
          language: "python3",
          code: "print(1)",
        },
      });
      // 不被保密规则拦截：状态由其他校验决定（400/201 均可能），只要不是 403
      assertEquals(control.status === 403, false);
    } finally {
      await cleanup(contestId, problemId);
      await getDb().delete(problems).where(eq(problems.id, controlProblemId))
        .catch(() => {});
    }
  },
});
