import { Hono } from "hono";
import {
  type AuthEnv,
  authMiddleware,
  optionalAuthMiddleware,
} from "../../identity/index.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import {
  type DomainTrainingInput,
  saveDomainTraining,
} from "../services/workspace/trainings.ts";
import {
  listDomainTrainings,
  readDomainTraining,
} from "../services/workspace/training-access.ts";
import {
  importDomainTraining,
  readDomainTrainingSharing,
  setDomainTrainingSharing,
} from "../services/workspace/training-sharing.ts";

/** 显式域题单准备路由，完整隔离门禁通过后由组合根挂载。 */
export const domainTrainingsRouter = new Hono<AuthEnv>();
const prefix = "/domains/:slug/trainings";
domainTrainingsRouter.use("/domains/:slug/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
function revision(header: string | undefined) {
  if (header === undefined) return null;
  const match = /^"?([0-9]+)"?$/.exec(header);
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw new BadRequestError("If-Match 必须是题单 revision");
  }
  return Number(match[1]);
}
domainTrainingsRouter.post(prefix, authMiddleware, async (c) => {
  const input = await parseJsonBody<DomainTrainingInput>(c);
  assertObjectBody(input);
  return c.json({
    data: await saveDomainTraining(c.req.param("slug")!, c.var.userId, input),
  }, 201);
});
domainTrainingsRouter.get(
  `${prefix}/:id`,
  optionalAuthMiddleware,
  async (c) =>
    c.json({
      data: await readDomainTraining(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.var.userId ?? null,
      ),
    }),
);
domainTrainingsRouter.patch(`${prefix}/:id`, authMiddleware, async (c) => {
  const input = await parseJsonBody<DomainTrainingInput>(c);
  assertObjectBody(input);
  return c.json({
    data: await saveDomainTraining(c.req.param("slug")!, c.var.userId, input, {
      id: c.req.param("id")!,
      revision: revision(c.req.header("If-Match")),
    }),
  });
});
domainTrainingsRouter.post(
  `${prefix}/:id/sharing`,
  authMiddleware,
  async (c) => {
    const input = await parseJsonBody<
      {
        enabled: boolean;
        scope: "all" | "selected";
        target_domain_slugs: string[];
      }
    >(c);
    assertObjectBody(input);
    return c.json({
      data: await setDomainTrainingSharing(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.var.userId,
        {
          enabled: input.enabled,
          scope: input.scope,
          targetDomainSlugs: input.target_domain_slugs,
          expectedRevision: revision(c.req.header("If-Match")),
        },
      ),
    });
  },
);
domainTrainingsRouter.post(
  "/domains/:slug/training-bindings",
  authMiddleware,
  async (c) => {
    const input = await parseJsonBody<{ training_id: string }>(c);
    assertObjectBody(input);
    if (
      typeof input.training_id !== "string" || !input.training_id
    ) throw new BadRequestError("需要源题单 ID");
    return c.json({
      data: await importDomainTraining(
        c.req.param("slug")!,
        input.training_id,
        c.var.userId,
      ),
    }, 201);
  },
);

/** 题单列表和共享设置分别读取当前域资源与本域来源授权。 */
domainTrainingsRouter.get(prefix, optionalAuthMiddleware, async (c) => {
  const { page, perPage } = parsePagination(c, { perPageField: "limit" });
  return c.json(
    await listDomainTrainings(c.req.param("slug")!, c.var.userId ?? null, {
      page,
      limit: perPage,
      keyword: c.req.query("keyword"),
    }),
  );
});
domainTrainingsRouter.get(
  `${prefix}/:id/sharing`,
  authMiddleware,
  async (c) =>
    c.json({
      data: await readDomainTrainingSharing(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.var.userId,
      ),
    }),
);
