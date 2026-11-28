import { Hono } from "hono";
import {
  authMiddleware,
  optionalAuthMiddleware,
} from "../../access/identity/middleware/auth.ts";
import { type OptionalAuthEnv } from "../../../shared/http/hono-env.ts";
import { userActorFromAuthenticatedId } from "../../access/contracts/actor.ts";
import {
  addDomainContestParticipantsCommand,
  createDomainContestCommand,
  registerDomainContestCommand,
  removeDomainContestParticipantCommand,
  updateDomainContestCommand,
} from "../../application/contests.ts";
import { BadRequestError, NotFoundError } from "../../../shared/base/errors.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import {
  buildPaginationMeta,
  parsePagination,
} from "../../../shared/http/pagination.ts";
import {
  getDomainContest,
  listDomainContestParticipants,
  listDomainContests,
} from "../services/domain-contests.ts";
import {
  findDomainContestSimilarSubmissions,
  getDomainContestFinalRanking,
  getDomainContestProblems,
  getDomainContestRanking,
  getDomainContestSettlement,
  getDomainContestSnapshotExport,
  getDomainContestSnapshots,
  publishDomainContestRanking,
} from "../services/domain-results.ts";
import {
  type CreateContestInput,
  isValidContestType,
  type UpdateContestInput,
} from "../types/contests.ts";
import { enforceContestRegisterRateLimit } from "../../platform/contracts/cross-module/system_services_hardening-rate-limit.ts";
import { loadDomainContest } from "../services/domain-access.ts";
import {
  createClarification,
  listClarifications,
  replyToClarification,
} from "../services/contest-clarifications.ts";
import { domainContestSseRouter } from "./sse.ts";
import {
  buildRankingCsv,
  buildRankingSnapshotJson,
  csvResponse,
  parseSimilarityLimit,
  parseSimilarityThreshold,
  parseSnapshotFile,
} from "./ranking-export.ts";
import {
  getDomainContestObjectiveQuestions,
  getDomainContestTemplate,
  getDomainContestUi,
} from "../services/domain-content.ts";

/** 显式域比赛入口，身份与资源归属由当前数据库授权。 */
export const domainContestRouter = new Hono<OptionalAuthEnv>();
domainContestRouter.use("/domains/:slug/contests", optionalAuthMiddleware);
domainContestRouter.use("/domains/:slug/contests/*", optionalAuthMiddleware);
for (const route of ["/domains/:slug/contests", "/domains/:slug/contests/*"]) {
  domainContestRouter.use(route, async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
}
const path = "/domains/:slug/contests";
async function body<T>(c: Parameters<typeof parseJsonBody>[0]) {
  const input = await parseJsonBody<unknown>(c);
  assertObjectBody(input);
  return input as T;
}
function revision(value?: string) {
  if (!value) return null;
  const match = /^"?([0-9]+)"?$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw new BadRequestError("If-Match 必须是比赛 revision");
  }
  return Number(match[1]);
}
/**
 * 比赛已没有公开范围分类、密码与邀请码。
 *
 * 旧客户端仍会带 `kind` / `is_public` / `password`。静默忽略最糟：调用方会以为自己的
 * 凭据或分类被接受了，实际只是走了统一报名 / 域默认值；因此显式拒绝并指出字段名。
 *
 * @param input 已解析的请求体
 * @throws {BadRequestError} 出现任一遗留字段
 */
function assertNoLegacyContestField(input: Record<string, unknown>): void {
  const legacy = ["password", "kind", "is_public"].filter((key) =>
    key in input
  );
  if (legacy.length > 0) {
    throw new BadRequestError(
      `比赛不再使用 ${legacy.join(" / ")}：报名由域访问权决定，请移除后重试`,
      "CONTEST_LEGACY_FIELD",
    );
  }
}
domainContestRouter.get(path, async (c) => {
  const { page, perPage } = parsePagination(c),
    type = c.req.query("type"),
    sort = c.req.query("sort");
  if (type && !isValidContestType(type)) {
    throw new BadRequestError("竞赛类型不合法");
  }
  if (sort && sort !== "recent" && sort !== "upcoming") {
    throw new BadRequestError("竞赛排序方式不合法");
  }
  const result = await listDomainContests(
    c.req.param("slug"),
    c.var.userId ?? null,
    {
      page,
      perPage,
      type: type && isValidContestType(type) ? type : undefined,
      classroomId: c.req.query("classroom_id"),
      myClassrooms: c.req.query("my_classrooms") === "true",
      sort: sort === "upcoming" || sort === "recent" ? sort : undefined,
    },
  );
  return c.json({
    data: result.data,
    pagination: buildPaginationMeta(page, perPage, result.total),
  });
});
domainContestRouter.post(
  path,
  authMiddleware,
  async (c) => {
    const actor = userActorFromAuthenticatedId(c.var.userId!);
    const input = await body<CreateContestInput & Record<string, unknown>>(c);
    assertNoLegacyContestField(input as unknown as Record<string, unknown>);
    return c.json({
      data: await createDomainContestCommand(
        actor,
        c.req.param("slug")!,
        input,
      ),
    }, 201);
  },
);
domainContestRouter.get(
  `${path}/:id`,
  async (c) =>
    c.json({
      data: await getDomainContest(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.var.userId ?? null,
      ),
    }),
);
domainContestRouter.patch(
  `${path}/:id`,
  authMiddleware,
  async (c) => {
    const actor = userActorFromAuthenticatedId(c.var.userId!);
    const input = await body<UpdateContestInput & Record<string, unknown>>(c);
    assertNoLegacyContestField(input as unknown as Record<string, unknown>);
    return c.json({
      data: await updateDomainContestCommand(
        actor,
        c.req.param("slug")!,
        c.req.param("id")!,
        revision(c.req.header("If-Match")),
        input,
      ),
    });
  },
);
domainContestRouter.post(`${path}/:id/register`, authMiddleware, async (c) => {
  // 比赛不再有密码/邀请码：报名不需要任何请求体。
  // 旧客户端带上 password/kind/is_public 时显式 400，避免它以为凭据被接受；
  // 空 body 与 `{}` 都视为"无凭据报名"（不再要求客户端伪造一个 JSON 对象）。
  const raw = await c.req.text();
  let input: Record<string, unknown> = {};
  if (raw.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new BadRequestError("请求体必须是 JSON 对象");
      }
      input = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof BadRequestError) throw error;
      throw new BadRequestError("请求体必须是合法 JSON");
    }
  }
  assertNoLegacyContestField(input);
  const access = await loadDomainContest(
    c.req.param("slug")!,
    c.req.param("id")!,
    c.var.userId!,
    { joining: true },
  );
  await enforceContestRegisterRateLimit(c, access.contest.id);
  const actor = userActorFromAuthenticatedId(c.var.userId!);
  await registerDomainContestCommand(
    actor,
    c.req.param("slug")!,
    c.req.param("id")!,
  );
  return c.json({ message: "竞赛注册成功" }, 201);
});
domainContestRouter.get(
  `${path}/:id/clarifications`,
  async (c) => {
    const access = await loadDomainContest(
      c.req.param("slug")!,
      c.req.param("id")!,
      c.var.userId ?? null,
    );
    const { page, perPage } = parsePagination(c);
    // 授权结论只在这里算一次（审计 F4）：答疑服务不再自行解释身份
    const result = await listClarifications(
      access.contest.id,
      {
        actorId: c.var.userId ?? undefined,
        canManage: access.organizer,
        isParticipant: access.registered,
      },
      { page, perPage },
    );
    return c.json({
      data: result.data,
      pagination: buildPaginationMeta(page, perPage, result.total),
    });
  },
);
domainContestRouter.post(
  `${path}/:id/clarifications`,
  authMiddleware,
  async (c) => {
    const access = await loadDomainContest(
      c.req.param("slug")!,
      c.req.param("id")!,
      c.var.userId!,
      { write: true },
    );
    return c.json({
      data: await createClarification(
        access.contest.id,
        c.var.userId!,
        await body<{ content?: string; problem_id?: string }>(c),
      ),
    }, 201);
  },
);
domainContestRouter.post(
  `${path}/:id/clarifications/:clarId/reply`,
  authMiddleware,
  async (c) => {
    const access = await loadDomainContest(
      c.req.param("slug")!,
      c.req.param("id")!,
      c.var.userId!,
      { manage: true },
    );
    return c.json({
      data: await replyToClarification(
        access.contest.id,
        c.req.param("clarId")!,
        c.var.userId!,
        {
          actorId: c.var.userId!,
          canManage: access.organizer,
          isParticipant: access.registered,
        },
        await body<{ content?: string; is_public?: boolean }>(c),
      ),
    }, 201);
  },
);
domainContestRouter.get(
  `${path}/:id/problems`,
  authMiddleware,
  async (c) =>
    c.json({
      data: await getDomainContestProblems(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.var.userId!,
      ),
    }),
);
domainContestRouter.get(
  `${path}/:id/problems/:label`,
  authMiddleware,
  async (c) => {
    const problems = await getDomainContestProblems(
      c.req.param("slug")!,
      c.req.param("id")!,
      c.var.userId!,
    );
    const problem = problems.find((item) =>
      item.label === c.req.param("label")
    );
    if (!problem) throw new NotFoundError("比赛题目不存在");
    return c.json({ data: problem });
  },
);
domainContestRouter.get(`${path}/:id/ranking`, async (c) => {
  const result = await getDomainContestRanking(
    c.req.param("slug")!,
    c.req.param("id")!,
    c.var.userId ?? null,
    c.req.query("classroom_id"),
  );
  return c.json({ data: result.rows, ...result, rows: undefined });
});
domainContestRouter.get(
  `${path}/:id/problems/:label/template`,
  authMiddleware,
  async (c) =>
    c.json(
      await getDomainContestTemplate(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.req.param("label")!,
        c.var.userId!,
      ),
    ),
);
domainContestRouter.get(
  `${path}/:id/problems/:label/ui`,
  authMiddleware,
  async (c) =>
    c.json(
      await getDomainContestUi(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.req.param("label")!,
        c.var.userId!,
      ),
    ),
);
domainContestRouter.get(
  `${path}/:id/problems/:label/objective-questions`,
  authMiddleware,
  async (c) =>
    c.json(
      await getDomainContestObjectiveQuestions(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.req.param("label")!,
        c.var.userId!,
      ),
    ),
);
domainContestRouter.get(
  `${path}/:id/final-ranking`,
  async (c) =>
    c.json(
      await getDomainContestFinalRanking(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.var.userId ?? null,
        c.req.query("classroom_id"),
      ),
    ),
);
domainContestRouter.get(
  `${path}/:id/participants`,
  authMiddleware,
  async (c) =>
    c.json({
      data: await listDomainContestParticipants(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.var.userId!,
      ),
    }),
);
domainContestRouter.post(
  `${path}/:id/participants`,
  authMiddleware,
  async (c) => {
    const input = await body<{ user_ids: string[] }>(c);
    return c.json({
      data: {
        added: await addDomainContestParticipantsCommand(
          userActorFromAuthenticatedId(c.var.userId!),
          c.req.param("slug")!,
          c.req.param("id")!,
          input.user_ids,
        ),
      },
    }, 201);
  },
);
domainContestRouter.delete(
  `${path}/:id/participants/:userId`,
  authMiddleware,
  async (c) => {
    await removeDomainContestParticipantCommand(
      userActorFromAuthenticatedId(c.var.userId!),
      c.req.param("slug")!,
      c.req.param("id")!,
      c.req.param("userId")!,
    );
    return c.json({ message: "已移除参赛者" });
  },
);
domainContestRouter.get(
  `${path}/:id/settlement`,
  authMiddleware,
  async (c) =>
    c.json({
      data: await getDomainContestSettlement(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.var.userId!,
      ),
    }),
);
domainContestRouter.get(
  `${path}/:id/snapshots`,
  authMiddleware,
  async (c) =>
    c.json({
      data: await getDomainContestSnapshots(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.var.userId!,
      ),
    }),
);
/**
 * 导出正式成绩：`latest.json` / `latest.csv` / `<版本号>.json` / `<版本号>.csv`。
 *
 * Hono 会把 `:version.json` 整体当作参数名，故用单段 `:file` 捕获后自行拆分。
 * 分数统一换算为展示量纲；CSV 流式写出并带 BOM，禁止缓存。
 */
domainContestRouter.get(
  `${path}/:id/snapshots/:file`,
  authMiddleware,
  async (c) => {
    const { version, format } = parseSnapshotFile(c.req.param("file"));
    const { contestId, snapshot } = await getDomainContestSnapshotExport(
      c.req.param("slug")!,
      c.req.param("id")!,
      c.var.userId!,
      version,
    );
    if (!snapshot) {
      throw new NotFoundError(
        version === undefined
          ? "尚未发布正式成绩"
          : `正式成绩第 ${version} 版不存在`,
      );
    }
    if (format === "json") {
      return c.json(buildRankingSnapshotJson(contestId, snapshot));
    }
    return csvResponse(
      buildRankingCsv(snapshot),
      `contest-${contestId}-ranking-v${snapshot.version}.csv`,
    );
  },
);
/**
 * 比赛内互相高度相似的提交对，供组织者人工复核，不代表作弊结论。
 *
 * query：`threshold` (0, 1] 默认 0.8；`limit` 1-200 默认 50；
 * `problem_id` 可选，本场赛题的题目 ID 或标签。响应不含源代码。
 */
domainContestRouter.get(
  `${path}/:id/anti-cheat/similar-submissions`,
  authMiddleware,
  async (c) => {
    const result = await findDomainContestSimilarSubmissions(
      c.req.param("slug")!,
      c.req.param("id")!,
      c.var.userId!,
      {
        threshold: parseSimilarityThreshold(c.req.query("threshold")),
        limit: parseSimilarityLimit(c.req.query("limit")),
        problem: c.req.query("problem_id")?.trim() || undefined,
      },
    );
    return c.json({
      data: result.data,
      meta: {
        threshold: result.threshold,
        limit: result.limit,
        total: result.total,
        truncated: result.truncated,
        candidates: result.candidates,
        participating: result.participating,
        skipped: result.skipped,
        buckets: result.buckets,
        max_submissions: result.max_submissions,
      },
      data_policy: {
        purpose: "竞赛期间代码相似度人工复核",
        retention_days: 180,
        automated_penalty: false,
      },
    });
  },
);
domainContestRouter.post(
  `${path}/:id/publish-ranking`,
  authMiddleware,
  async (c) =>
    c.json({
      data: await publishDomainContestRanking(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.var.userId!,
        await body<{ note?: string; allow_failed?: boolean }>(c),
      ),
    }, 201),
);
domainContestRouter.route("/", domainContestSseRouter);
