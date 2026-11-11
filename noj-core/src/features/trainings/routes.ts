import { Hono } from "hono";
import { userActorFromAuthenticatedId } from "../../modules/access/contracts/actor.ts";
import {
  authMiddleware,
  optionalAuthMiddleware,
} from "../../modules/access/index.ts";
import { type AuthEnv } from "../../shared/http/hono-env.ts";
import { parsePagination } from "../../shared/http/pagination.ts";
import { BadRequestError } from "../../shared/base/errors.ts";
import { assertObjectBody, parseJsonBody } from "../../shared/http/request.ts";
import {
  deleteDomainTraining,
  type DomainTrainingInput,
  saveDomainTraining,
} from "./service.ts";
import { copyDomainTraining } from "./copy.ts";
import { listDomainTrainings, readDomainTraining } from "./access.ts";

/** 显式域题单入口，引用与原题授权在读取和写入时检查。 */
export const domainTrainingsRouter = new Hono<AuthEnv>();
const prefix = "/domains/:slug/trainings";
// 只作用于本功能路径：功能路由挂在清单末尾，过宽的通配会波及后续路由。
for (
  const path of [prefix, `${prefix}/*`, "/domains/:slug/training-bindings"]
) {
  domainTrainingsRouter.use(path, async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
}
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
    data: await saveDomainTraining(
      c.req.param("slug")!,
      userActorFromAuthenticatedId(c.var.userId).userId,
      input,
    ),
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
    data: await saveDomainTraining(
      c.req.param("slug")!,
      userActorFromAuthenticatedId(c.var.userId).userId,
      input,
      {
        id: c.req.param("id")!,
        revision: revision(c.req.header("If-Match")),
      },
    ),
  });
});
domainTrainingsRouter.put(`${prefix}/:id`, authMiddleware, async (c) => {
  const input = await parseJsonBody<DomainTrainingInput>(c);
  assertObjectBody(input);
  return c.json({
    data: await saveDomainTraining(
      c.req.param("slug")!,
      userActorFromAuthenticatedId(c.var.userId).userId,
      input,
      {
        id: c.req.param("id")!,
        revision: revision(c.req.header("If-Match")),
      },
    ),
  });
});
domainTrainingsRouter.delete(`${prefix}/:id`, authMiddleware, async (c) => {
  await deleteDomainTraining(
    c.req.param("slug")!,
    userActorFromAuthenticatedId(c.var.userId).userId,
    c.req.param("id")!,
  );
  return c.body(null, 204);
});
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
      data: await copyDomainTraining(
        c.req.param("slug")!,
        input.training_id,
        userActorFromAuthenticatedId(c.var.userId).userId,
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
      createdBy: c.req.query("created_by"),
    }),
  );
});
