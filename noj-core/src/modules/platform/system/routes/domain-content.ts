import { Hono } from "hono";
import type { Context } from "hono";
import {
  authMiddleware,
  optionalAuthMiddleware,
} from "../../../access/identity/middleware/auth.ts";
import type { OptionalAuthEnv } from "../../../../shared/http/hono-env.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../../shared/http/request.ts";
import { parsePagination } from "../../../../shared/http/pagination.ts";
import { UnauthorizedError } from "../../../../shared/base/errors.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../../../access/contracts/cross-module/workspace_services_access.ts";
import { enforceRateLimit } from "../services/hardening-rate-limit.ts";
import {
  type ContentScope,
  contentSource,
} from "../../services/content-scope.ts";
import { getClientIp } from "../services/rate-limit-env.ts";
import {
  requireUserActor,
  type UserActor,
} from "../../../access/contracts/actor.ts";
import {
  createAnnouncement,
  type CreateAnnouncementInput,
  deleteAnnouncement,
  getLatestBannerAnnouncement,
  getPublicAnnouncement,
  listAdminAnnouncements,
  listPublicAnnouncements,
  resolveAnnouncementId,
  updateAnnouncement,
  type UpdateAnnouncementInput,
} from "../../services/announcements.ts";

type ContentEnv = OptionalAuthEnv & {
  Variables: { contentScope: ContentScope };
};
const router = new Hono<ContentEnv>();
const prefix = "/domains/:slug";

function authenticatedActor(c: Context<ContentEnv>): UserActor {
  const actor = c.get("actor");
  if (!actor) throw new UnauthorizedError("未提供认证身份");
  return requireUserActor(actor);
}
const readPrefixes = [
  `${prefix}/announcements`,
  `${prefix}/announcements/*`,
];
for (const path of readPrefixes) {
  router.use(path, optionalAuthMiddleware, async (c, next) => {
    const access = await loadWorkspace(
      c.req.param("slug")!,
      c.var.userId ?? null,
    );
    c.set("contentScope", { domainId: access.domain.id });
    c.header("Cache-Control", "private, no-store");
    await next();
  });
}
for (
  const path of [
    `${prefix}/settings/announcements`,
    `${prefix}/settings/announcements/*`,
  ]
) {
  router.use(path, authMiddleware, async (c, next) => {
    const write = c.req.method !== "GET";
    const access = await loadWorkspace(c.req.param("slug")!, c.var.userId!, {
      write,
    });
    assertWorkspacePermission(access.context, "domain:settings");
    c.set("contentScope", { domainId: access.domain.id });
    c.header("Cache-Control", "private, no-store");
    if (write) {
      await enforceRateLimit(
        `domain-content:${access.domain.id}:${c.var.userId}`,
        { windowSec: 60, max: 30 },
      );
    }
    return await next();
  });
}

const sourced = <T extends { domain_id: string | null }>(item: T) => ({
  ...item,
  scope: contentSource(item.domain_id),
});
async function objectBody(c: Parameters<typeof parseJsonBody>[0]) {
  const value = await parseJsonBody<unknown>(c);
  assertObjectBody(value);
  return value;
}

router.get(`${prefix}/announcements`, async (c) => {
  const { page, perPage } = parsePagination(c);
  const result = await listPublicAnnouncements(
    page,
    perPage,
    c.var.contentScope,
  );
  return c.json({ ...result, data: result.data.map(sourced) });
});
router.get(`${prefix}/announcements/banner`, async (c) => {
  const result = await getLatestBannerAnnouncement(c.var.contentScope);
  return c.json({ data: result ? sourced(result) : null });
});
router.get(`${prefix}/announcements/:id`, async (c) => {
  const id = await resolveAnnouncementId(c.req.param("id"));
  return c.json({
    data: sourced(await getPublicAnnouncement(id, c.var.contentScope)),
  });
});

const notices = `${prefix}/settings/announcements`;
router.get(notices, async (c) => {
  const { page, perPage } = parsePagination(c);
  const active = c.req.query("is_active");
  const result = await listAdminAnnouncements(
    page,
    perPage,
    active === undefined ? undefined : active === "true",
    c.var.contentScope,
  );
  return c.json({ ...result, data: result.data.map(sourced) });
});
router.post(
  notices,
  async (c) =>
    c.json({
      data: sourced(
        await createAnnouncement(
          await objectBody(c) as unknown as CreateAnnouncementInput,
          authenticatedActor(c),
          c.var.contentScope,
          { ipAddress: getClientIp(c) },
        ),
      ),
    }, 201),
);
router.put(`${notices}/:id`, async (c) => {
  const id = await resolveAnnouncementId(c.req.param("id"));
  return c.json({
    data: sourced(
      await updateAnnouncement(
        id,
        await objectBody(c) as UpdateAnnouncementInput,
        authenticatedActor(c),
        c.var.contentScope,
        { ipAddress: getClientIp(c) },
      ),
    ),
  });
});
router.delete(`${notices}/:id`, async (c) => {
  const id = await resolveAnnouncementId(c.req.param("id"));
  await deleteAnnouncement(
    id,
    authenticatedActor(c),
    c.var.contentScope,
    { ipAddress: getClientIp(c) },
  );
  return c.body(null, 204);
});

export default router;
