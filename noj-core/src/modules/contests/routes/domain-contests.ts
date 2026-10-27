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
  getDomainContestFinalRanking,
  getDomainContestProblems,
  getDomainContestRanking,
  getDomainContestSettlement,
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
domainContestRouter.get(path, async (c) => {
  const { page, perPage } = parsePagination(c), type = c.req.query("type");
  if (type && !isValidContestType(type)) {
    throw new BadRequestError("竞赛类型不合法");
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
    return c.json({
      data: await createDomainContestCommand(
        actor,
        c.req.param("slug")!,
        await body<CreateContestInput>(c),
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
    return c.json({
      data: await updateDomainContestCommand(
        actor,
        c.req.param("slug")!,
        c.req.param("id")!,
        revision(c.req.header("If-Match")),
        await body<UpdateContestInput>(c),
      ),
    });
  },
);
domainContestRouter.post(`${path}/:id/register`, authMiddleware, async (c) => {
  const input = await body<{ password?: string }>(c);
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
    input.password,
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
    const result = await listClarifications(
      access.contest.id,
      c.var.userId ?? undefined,
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
