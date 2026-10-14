import { Hono } from "hono";
import {
  authMiddleware,
  optionalAuthMiddleware,
  requireAdmin,
} from "../../identity/index.ts";
import type { OptionalAuthEnv } from "../../../shared/http/hono-env.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../shared/http/request.ts";
import { AppError, BadRequestError } from "../../../shared/base/errors.ts";
import { getDb } from "../../../shared/db/connection.ts";
import { userWorkspacePreferences } from "../../../shared/db/schema.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";
import type {
  DomainConfiguration,
  DomainLimits,
  DomainPreset,
  DomainRole,
} from "../../../shared/workspace/types.ts";
import {
  getDomainEffectiveLimits,
  updateDomainLimits,
} from "../services/limits.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../services/access.ts";
import {
  createDomain,
  listDomains,
  setDomainStatus,
  updateDomain,
} from "../services/domains.ts";
import { getInstancePolicy } from "../services/instance.ts";
import {
  consumeDomainInvitation,
  createDomainInvitation,
  listDomainInvitations,
  previewDomainInvitation,
  revokeDomainInvitation,
} from "../services/invitations.ts";
import {
  joinDomain,
  listDomainJoinRequests,
  listDomainMembers,
  removeDomainMember,
  reviewJoinRequest,
  setMemberRoles,
  transferDomain,
} from "../services/members.ts";
import {
  requestDomainCreation,
  reviewDomainCreation,
} from "../services/creation-requests.ts";
import { DOMAIN_PRESETS } from "../../../shared/workspace/types.ts";
import { constrainDomainConfiguration } from "../../../shared/workspace/resource-policy.ts";
import { getInstanceResourcePolicy } from "../services/instance.ts";
import {
  listAdminDomains,
  listDomainCreationRequests,
} from "../services/governance.ts";
import { getDomainResourceUsage } from "../services/resource-usage.ts";

const router = new Hono<OptionalAuthEnv>();
// 挂载到 /api/v1 时通配中间件会影响其他模块，只限定本模块的路径。
for (
  const path of [
    "/instance",
    "/domains",
    "/domains/*",
    "/me/domains",
    "/me/workspace-preference",
    "/auth/domain-invitation",
    "/domain-invitations/*",
    "/domain-creation-requests",
    "/admin/instance/*",
  ]
) {
  router.use(path, async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Vary", "Authorization, Cookie", { append: true });
    await next();
  });
}

function revisionHeader(value: string | undefined) {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new AppError("请携带 If-Match 配置版本", 428, "REVISION_REQUIRED");
  }
  return Number(value);
}
function presetValue(value: unknown): DomainPreset {
  if (
    typeof value !== "string" ||
    !DOMAIN_PRESETS.includes(value as DomainPreset)
  ) throw new BadRequestError("域类型须为社区、教学或团队");
  return value as DomainPreset;
}
async function body(c: Parameters<typeof parseJsonBody>[0]) {
  const value = await parseJsonBody<unknown>(c);
  assertObjectBody(value);
  return value;
}

router.get("/instance", (c) => c.json({ data: getInstancePolicy() }));
router.get(
  "/domains",
  optionalAuthMiddleware,
  async (c) => c.json({ data: await listDomains(c.var.userId ?? null) }),
);
router.get(
  "/me/domains",
  authMiddleware,
  async (c) => c.json({ data: await listDomains(c.var.userId!, true) }),
);
router.post("/domains", authMiddleware, async (c) => {
  const input = await body(c);
  return c.json({
    data: await createDomain({
      slug: input.slug as string,
      name: input.name as string,
      preset: presetValue(input.preset),
      description: input.description as string | undefined,
    }, c.var.userId!),
  }, 201);
});
router.post("/domain-creation-requests", authMiddleware, async (c) => {
  const input = await body(c);
  return c.json({
    data: await requestDomainCreation(c.var.userId!, {
      slug: input.slug as string,
      name: input.name as string,
      preset: presetValue(input.preset),
      reason: input.reason as string,
    }),
  }, 201);
});
router.get(
  "/admin/instance/domains",
  authMiddleware,
  requireAdmin(),
  async (c) =>
    c.json(
      await listAdminDomains(c.var.userId!, parsePagination(c), {
        status: c.req.query("status"),
        keyword: c.req.query("keyword"),
      }),
    ),
);
router.get(
  "/admin/instance/domain-creation-requests",
  authMiddleware,
  requireAdmin(),
  async (c) =>
    c.json(
      await listDomainCreationRequests(
        c.var.userId!,
        parsePagination(c),
        c.req.query("status"),
      ),
    ),
);
router.post(
  "/admin/instance/domain-creation-requests/:id/review",
  authMiddleware,
  requireAdmin(),
  async (c) => {
    const input = await body(c);
    if (typeof input.approved !== "boolean") {
      throw new BadRequestError(
        "审批决定非法",
      );
    }
    return c.json({
      data: await reviewDomainCreation(
        c.req.param("id")!,
        c.var.userId!,
        input.approved,
      ),
    });
  },
);
router.post("/domain-invitations/accept", authMiddleware, async (c) => {
  const input = await body(c);
  return c.json({
    data: await consumeDomainInvitation(input.token as string, c.var.userId!),
  });
});
router.post("/auth/domain-invitation", async (c) => {
  const input = await body(c);
  return c.json({ data: await previewDomainInvitation(input.token as string) });
});
router.get("/domains/:slug", optionalAuthMiddleware, async (c) => {
  const { domain, context, membership, platformAdmin } = await loadWorkspace(
    c.req.param("slug")!,
    c.var.userId ?? null,
  );
  return c.json({
    data: {
      ...domain,
      configuration: constrainDomainConfiguration(
        domain.configuration,
        (await getInstanceResourcePolicy()).modules,
      ),
      permissions: [...context.domainPermissions],
      is_member: !!membership,
      platform_admin: platformAdmin,
      actor_id: context.actorId,
    },
  });
});
router.get("/domains/:slug/limits", authMiddleware, async (c) => {
  const { domain, context } = await loadWorkspace(
    c.req.param("slug")!,
    c.var.userId!,
  );
  assertWorkspacePermission(context, "domain:limits");
  return c.json({
    data: {
      ...await getDomainEffectiveLimits(domain.id),
      usage: await getDomainResourceUsage(domain.id),
      revision: domain.revision,
    },
  });
});
router.patch("/domains/:slug/limits", authMiddleware, async (c) => {
  const input = await body(c);
  return c.json({
    data: await updateDomainLimits(
      c.req.param("slug")!,
      c.var.userId!,
      revisionHeader(c.req.header("If-Match")),
      input as unknown as DomainLimits,
    ),
  });
});
router.patch("/domains/:slug", authMiddleware, async (c) => {
  const input = await body(c);
  if (input.preset !== undefined) {
    throw new BadRequestError("域类型创建后固定", "DOMAIN_TYPE_FIXED");
  }
  return c.json({
    data: await updateDomain(
      c.req.param("slug")!,
      c.var.userId!,
      revisionHeader(c.req.header("If-Match")),
      {
        name: input.name as string | undefined,
        description: input.description as string | undefined,
        configuration: input.configuration as DomainConfiguration | undefined,
      },
    ),
  });
});
router.post("/domains/:slug/status", authMiddleware, async (c) => {
  const input = await body(c);
  return c.json({
    data: await setDomainStatus(
      c.req.param("slug")!,
      c.var.userId!,
      input.status as "active",
      revisionHeader(c.req.header("If-Match")),
    ),
  });
});
router.post("/domains/:slug/join", authMiddleware, async (c) => {
  const input = await body(c);
  return c.json({
    data: await joinDomain(
      c.req.param("slug")!,
      c.var.userId!,
      input.reason as string | undefined,
    ),
  });
});
router.get("/domains/:slug/join-requests", authMiddleware, async (c) => {
  return c.json({
    data: await listDomainJoinRequests(c.req.param("slug")!, c.var.userId!),
  });
});
router.post(
  "/domains/:slug/join-requests/:id/review",
  authMiddleware,
  async (c) => {
    const input = await body(c);
    if (typeof input.approved !== "boolean") {
      throw new BadRequestError(
        "审批决定非法",
      );
    }
    return c.json({
      data: await reviewJoinRequest(
        c.req.param("slug")!,
        c.req.param("id")!,
        c.var.userId!,
        input.approved,
      ),
    });
  },
);
router.get(
  "/domains/:slug/members",
  authMiddleware,
  async (c) => {
    const raw = c.req.query("page") ?? "1";
    const page = Number(raw);
    if (
      !/^\d+$/.test(raw) || !Number.isSafeInteger(page) || page < 1 ||
      page > 10000
    ) throw new BadRequestError("成员页码非法");
    return c.json({
      data: await listDomainMembers(
        c.req.param("slug")!,
        c.var.userId!,
        (page - 1) * 100,
      ),
      page,
      per_page: 100,
    });
  },
);
router.put(
  "/domains/:slug/members/:userId/roles",
  authMiddleware,
  async (c) => {
    const input = await body(c);
    return c.json({
      data: await setMemberRoles(
        c.req.param("slug")!,
        c.var.userId!,
        c.req.param("userId")!,
        input.roles as DomainRole[],
      ),
    });
  },
);
router.delete(
  "/domains/:slug/members/:userId",
  authMiddleware,
  async (c) =>
    c.json({
      data: await removeDomainMember(
        c.req.param("slug")!,
        c.var.userId!,
        c.req.param("userId")!,
      ),
    }),
);
router.post("/domains/:slug/transfer", authMiddleware, async (c) => {
  const input = await body(c);
  if (typeof input.user_id !== "string") {
    throw new BadRequestError("负责人账号非法");
  }
  return c.json({
    data: await transferDomain(
      c.req.param("slug")!,
      c.var.userId!,
      input.user_id,
    ),
  });
});
router.post("/domains/:slug/invitations", authMiddleware, async (c) => {
  const input = await body(c);
  return c.json({
    data: await createDomainInvitation(
      c.req.param("slug")!,
      c.var.userId!,
      input.email as string,
    ),
  }, 201);
});
router.get("/domains/:slug/invitations", authMiddleware, async (c) => {
  return c.json({
    data: await listDomainInvitations(c.req.param("slug")!, c.var.userId!),
  });
});
router.delete(
  "/domains/:slug/invitations/:id",
  authMiddleware,
  async (c) =>
    c.json({
      data: await revokeDomainInvitation(
        c.req.param("slug")!,
        c.var.userId!,
        c.req.param("id")!,
      ),
    }),
);
router.put("/me/workspace-preference", authMiddleware, async (c) => {
  const input = await body(c);
  if (typeof input.slug !== "string") {
    throw new BadRequestError("工作空间标识非法");
  }
  const { domain } = await loadWorkspace(input.slug, c.var.userId!);
  await getDb().insert(userWorkspacePreferences).values({
    user_id: c.var.userId!,
    last_domain_id: domain.id,
    updated_at: new Date().toISOString(),
  }).onConflictDoUpdate({
    target: userWorkspacePreferences.user_id,
    set: { last_domain_id: domain.id, updated_at: new Date().toISOString() },
  });
  return c.json({ data: { slug: domain.slug } });
});

/** 工作空间产品路由，所有业务资源仍须独立完成域归属迁移。 */
export const workspaceRouter = router;
