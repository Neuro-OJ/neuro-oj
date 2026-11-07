/** 默认域兼容入口也遵循同域保护 403、隐藏域 404 与管理预览规则。 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { createApp } from "../../../../app.ts";
import { createProblem } from "../../index.ts";
import { createContest, deleteContest } from "../../../contests/index.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { contests, problems } from "../../../../shared/db/schema.ts";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
  publishBaselineVersionForTest,
} from "../../../../../tests/helper.ts";

await resetDbForTest();
await initRedisForTest();

/** 创建一道 public 的 U 型题，并指定 owner。 */
async function createOwnedPublicProblem(ownerId: string): Promise<string> {
  await grantDefaultCatalogRole(ownerId, "educator");
  // 不带 userId 走服务端流程：绕过"敏感字段（evaluator.command）需权限"的守卫，
  // 随后再把 owner_id 落到目标用户，模拟"普通用户拥有的公开题"。
  const created = await createProblem({
    title: `保密规则路由测试题 ${Date.now()}_${
      Math.random().toString(36).slice(2, 8)
    }`,
    description: "测试描述",
    difficulty: "easy",
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
  // 竞赛只能固定**已发布**版本（Handbook §2.6）：补迁移基线 V1
  await publishBaselineVersionForTest(created.id);
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
  name: "保密规则: 关联未结束公开赛的题目对匿名 403（不泄露存在性）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const { problemId, contestId } = await setupRunningPublicContest();
    try {
      const res = await jsonRequest(app, `/api/v1/problems/${problemId}`);
      assertEquals(res.status, 403);
      assertEquals((await res.json()).code, "CONTEST_PROBLEM_RESTRICTED");
    } finally {
      await cleanup(contestId, problemId);
    }
  },
});

Deno.test({
  name: "保密规则: 关联未结束公开赛的题目对非 owner 登录用户 403",
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
      assertEquals(res.status, 403);
    } finally {
      await cleanup(contestId, problemId);
    }
  },
});

Deno.test({
  name: "保密规则: 题目所有者可见，并收到 contest_secrecy 保密提示",
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
  name: "保密规则: 旧邀请赛字段不再绕过保护",
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
      assertEquals(res.status, 403);
    } finally {
      await cleanup(contestId, problemId);
    }
  },
});

Deno.test({
  name: "保密规则: 赛前（pending）公开赛同样保密",
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
        403,
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
  name: "保密规则: 公开统计接口对匿名 403（不留统计侧预言机）",
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
      assertEquals(res.status, 403);
    } finally {
      await cleanup(contestId, problemId);
    }
  },
});

Deno.test({
  name: "保密规则: starter code 模板对非 owner 403（此前无访问校验）",
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
      assertEquals(res.status, 403);
    } finally {
      await cleanup(contestId, problemId);
    }
  },
});

Deno.test({
  name: "保密规则: 支持包路由对非 owner 403，且不改变既有包权限口径",
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
      // 保密命中：先于包权限校验返回 403「题目不存在」
      const secret = await jsonRequest(
        app,
        `/api/v1/problems/${problemId}/support-package`,
        { token: otherToken },
      );
      assertEquals(secret.status, 403);
      assertEquals((await secret.json()).code, "CONTEST_PROBLEM_RESTRICTED");

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
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const { problemId, contestId } = await setupRunningPublicContest();
    // 域入口要求当前域授予 `submission:create`（旧无域入口只校验登录）：
    // 用 member 角色身份，才能让 403 落在"保密"而不是"权限"上。
    const otherToken = await createDefaultCatalogToken("member");
    // 对照题：同样是 public U 型题，但不属于任何竞赛
    const controlOwnerToken = await createUserToken();
    const controlOwnerId = decodeJwt(controlOwnerToken).sub as string;
    const controlProblemId = await createOwnedPublicProblem(controlOwnerId);
    try {
      // 0.11 起提交只走域入口：按题号定位题目（无域 POST /submissions 已删除）。
      // 题号直接从库里读：这道题正是"保密中"，走 HTTP 读详情会被 403 挡住。
      const [secretRow] = await getDb().select({
        number: problems.number,
        versionId: problems.latest_version_id,
      }).from(problems).where(eq(problems.id, problemId));
      const problemRef = String(secretRow!.number);
      const secret = await jsonRequest(
        app,
        "/api/v1/domains/main/submissions",
        {
          method: "POST",
          token: otherToken,
          body: {
            problem_ref: problemRef,
            version_id: secretRow!.versionId,
            language: "python3",
            code: "print(1)",
          },
        },
      );
      assertEquals(secret.status, 403);
      // 用机器码判定：文案是"此题受比赛保护…"，按文案匹配会随措辞漂移。
      const secretBody = await secret.clone().json() as { code?: string };
      assertEquals(secretBody.code, "CONTEST_PROBLEM_RESTRICTED");

      const [controlRow] = await getDb().select({
        number: problems.number,
        versionId: problems.latest_version_id,
      }).from(problems).where(eq(problems.id, controlProblemId));
      const controlRef = String(controlRow!.number);
      const control = await jsonRequest(
        app,
        "/api/v1/domains/main/submissions",
        {
          method: "POST",
          token: otherToken,
          body: {
            problem_ref: controlRef,
            version_id: controlRow!.versionId,
            language: "python3",
            code: "print(1)",
          },
        },
      );
      // 对照题不被**保密规则**拦截：域入口可能因其他原因拒绝（如权限/版本），
      // 因此这里断言"拒绝理由里没有保密"，而不是"状态码不是 403"——
      // 旧无域路径已删除，域名提交的 403 也可能是权限，不能混为一谈。
      const controlBody = await control.json() as { code?: string };
      assertEquals(controlBody.code === "CONTEST_PROBLEM_RESTRICTED", false);
    } finally {
      await cleanup(contestId, problemId);
      await getDb().delete(problems).where(eq(problems.id, controlProblemId))
        .catch(() => {});
    }
  },
});

import { resetDbForTest } from "../default-fixture.ts";

import {
  createDefaultCatalogToken,
  grantDefaultCatalogRole,
} from "../default-fixture.ts";
