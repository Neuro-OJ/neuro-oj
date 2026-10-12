import { Hono } from "hono";
import {
  type AuthEnv,
  authMiddleware,
  optionalAuthMiddleware,
} from "../../identity/index.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import {
  type DomainTrainingInput,
  saveDomainTraining,
} from "../services/workspace/trainings.ts";
import { readDomainTraining } from "../services/workspace/training-access.ts";
import {
  importDomainTraining,
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
        target_domain_ids: string[];
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
          targetDomainIds: input.target_domain_ids,
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
