import { Hono } from "hono";
import { userActorFromAuthenticatedId } from "../../access/contracts/actor.ts";
import {
  importDomainProblemCommand,
  setDomainProblemBindingPolicyCommand,
} from "../../application/problems.ts";
import { authMiddleware } from "../../access/identity/middleware/auth.ts";
import { type AuthEnv } from "../../../shared/http/hono-env.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import { listDomainProblemBindings } from "../services/workspace/problem-bindings.ts";
import type { EffectiveVersionPolicy } from "../../../shared/versioning/types.ts";
import { listSharedDomainResources } from "../services/workspace/problem-sharing.ts";

/** 域资源管理接口只返回来源标识及授权配置，不返回源题评测数据。 */
export const domainResourceManagementRouter = new Hono<AuthEnv>();
const prefix = "/domains/:slug";
domainResourceManagementRouter.use(`${prefix}/*`, async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
function revision(header: string | undefined) {
  if (header === undefined) return null;
  const match = /^"?([0-9]+)"?$/.exec(header);
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw new BadRequestError("If-Match 必须为非负 revision");
  }
  return Number(match[1]);
}
domainResourceManagementRouter.get(
  `${prefix}/problem-bindings`,
  authMiddleware,
  async (c) => {
    const { page, perPage } = parsePagination(c, { perPageField: "limit" });
    return c.json(
      await listDomainProblemBindings(c.req.param("slug")!, c.var.userId, {
        page,
        limit: perPage,
        keyword: c.req.query("keyword"),
      }),
    );
  },
);
domainResourceManagementRouter.post(
  `${prefix}/problem-bindings`,
  authMiddleware,
  async (c) => {
    const input = await parseJsonBody<
      { source_ref: string; version_id?: string }
    >(c);
    assertObjectBody(input);
    if (typeof input.source_ref !== "string") {
      throw new BadRequestError(
        "需要来源题号 source_ref",
      );
    }
    if (
      input.version_id !== undefined &&
      (typeof input.version_id !== "string" || !input.version_id)
    ) {
      throw new BadRequestError("version_id 必须为已发布版本 ID");
    }
    return c.json({
      data: await importDomainProblemCommand(
        userActorFromAuthenticatedId(c.var.userId),
        c.req.param("slug")!,
        input.source_ref,
        input.version_id,
      ),
    }, 201);
  },
);
domainResourceManagementRouter.put(
  `${prefix}/problems/:reference/policy`,
  authMiddleware,
  async (c) => {
    const input = await parseJsonBody<
      { policy: EffectiveVersionPolicy; reason: string }
    >(c);
    assertObjectBody(input);
    return c.json({
      data: await setDomainProblemBindingPolicyCommand(
        userActorFromAuthenticatedId(c.var.userId),
        c.req.param("slug")!,
        c.req.param("reference")!,
        revision(c.req.header("If-Match")),
        input.policy,
        input.reason,
      ),
    });
  },
);
domainResourceManagementRouter.get(
  `${prefix}/shared-resources`,
  authMiddleware,
  async (c) => {
    const { page, perPage } = parsePagination(c, { perPageField: "limit" });
    const kind = c.req.query("kind") ?? "problem";
    if (kind !== "problem" && kind !== "training") {
      throw new BadRequestError(
        "kind 必须是 problem 或 training",
      );
    }
    return c.json(
      await listSharedDomainResources(c.req.param("slug")!, c.var.userId, {
        kind,
        page,
        limit: perPage,
        sourceSlug: c.req.query("source_slug"),
        keyword: c.req.query("keyword"),
      }),
    );
  },
);
