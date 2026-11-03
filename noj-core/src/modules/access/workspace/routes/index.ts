import { Hono } from "hono";
import type { Context } from "hono";
import {
  authMiddleware,
  optionalAuthMiddleware,
} from "../../identity/middleware/auth.ts";
import { requireAdmin } from "../../identity/services/security/permissions.ts";
import type { OptionalAuthEnv } from "../../../../shared/http/hono-env.ts";
import {
  assertObjectBody,
  parseJsonBody,
} from "../../../../shared/http/request.ts";
import {
  AppError,
  BadRequestError,
  UnauthorizedError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { userWorkspacePreferences } from "../../../../shared/db/schema.ts";
import {
  buildPaginationMeta,
  parsePagination,
} from "../../../../shared/http/pagination.ts";
import type {
  DomainLimits,
  DomainPreset,
} from "../../../../shared/workspace/types.ts";
import {
  getDomainEffectiveLimits,
  updateDomainLimits,
} from "../services/limits.ts";
import {
  type AccessActor,
  assertWorkspacePermission,
  loadWorkspace,
} from "../../policy.ts";
import { listDomains } from "../../domains.ts";
import { getInstancePolicy } from "../services/instance.ts";
import { listDomainInvitations } from "../../invitations.ts";
import {
  listDomainJoinRequests,
  listDomainMembersPage,
} from "../../members.ts";
import {
  requestDomainCreation,
  reviewDomainCreation,
} from "../services/creation-requests.ts";
import { DOMAIN_PRESETS } from "../../../../shared/workspace/types.ts";
import { constrainDomainConfiguration } from "../../../../shared/workspace/resource-policy.ts";
import { getInstanceResourcePolicy } from "../services/instance.ts";
import {
  listAdminDomains,
  listDomainCreationRequests,
} from "../services/governance.ts";
import { getDomainResourceUsage } from "../services/resource-usage.ts";
import {
  readInstanceSettings,
  saveInstanceSettings as savePlatformInstanceSettings,
} from "../../../platform/contracts/cross-module/services_instance-settings.ts";
import {
  consumeDomainInvitationCommand,
  createDomainCommand,
  createDomainInvitationCommand,
  joinDomainCommand,
  previewDomainInvitationCommand,
  removeDomainMemberCommand,
  reviewJoinRequestCommand,
  revokeDomainInvitationCommand,
  setDomainStatusCommand,
  setMemberRoleCommand,
  transferDomainCommand,
  updateDomainCommand,
} from "../../../application/access.ts";
import {
  guestActor,
  requireUserActor,
  type UserActor,
  userActorFromAuthenticatedId,
} from "../../contracts/actor.ts";

const router = new Hono<OptionalAuthEnv>();

/** authMiddleware 已注入 actor；HTTP 适配器在进入写用例前显式收紧类型。 */
function authenticatedActor(c: Context<OptionalAuthEnv>): UserActor {
  const actor = c.get("actor");
  if (!actor) throw new UnauthorizedError("未提供认证身份");
  return requireUserActor(actor);
}
/** 读路径的显式 access actor：认证用户或匿名访客，不能从客户端字段构造。 */
function requestActor(c: Context<OptionalAuthEnv>): AccessActor {
  const actor = c.get("actor");
  if (actor && actor.kind !== "system") return actor;
  const userId = c.var.userId;
  return userId ? userActorFromAuthenticatedId(userId) : guestActor();
}
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
  "/admin/instance/settings/:section",
  authMiddleware,
  requireAdmin(),
  async (c) => {
    return c.json({
      data: await readInstanceSettings(c.req.param("section")!),
    });
  },
);
router.patch(
  "/admin/instance/settings/:section",
  authMiddleware,
  requireAdmin(),
  async (c) => {
    const input = await body(c);
    assertObjectBody(input.values);
    return c.json({
      data: await savePlatformInstanceSettings(
        c.req.param("section")!,
        input.values,
        c.req.header("If-Match"),
        authenticatedActor(c),
      ),
    });
  },
);
router.get(
  "/domains",
  optionalAuthMiddleware,
  async (c) =>
    c.json({
      data: await listDomains(
        c.var.userId ? requestActor(c) as UserActor : null,
      ),
    }),
);
router.get(
  "/me/domains",
  authMiddleware,
  async (c) =>
    c.json({ data: await listDomains(requestActor(c) as UserActor, true) }),
);
router.post("/domains", authMiddleware, async (c) => {
  const input = await body(c);
  const actor = authenticatedActor(c);
  return c.json({
    data: await createDomainCommand(actor, {
      slug: input.slug as string,
      name: input.name as string,
      preset: presetValue(input.preset),
      description: input.description as string | undefined,
    }),
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
    data: await consumeDomainInvitationCommand(
      authenticatedActor(c),
      (input.token ?? input.code) as string,
    ),
  });
});
router.post("/auth/domain-invitation", async (c) => {
  const input = await body(c);
  return c.json({
    data: await previewDomainInvitationCommand(
      (input.token ?? input.code) as string,
    ),
  });
});
router.get("/domains/:slug", optionalAuthMiddleware, async (c) => {
  const { domain, context, membership, platformAdmin } = await loadWorkspace(
    c.req.param("slug")!,
    requestActor(c),
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
      actor_id: context.actor.kind === "user" ? context.actor.userId : null,
    },
  });
});
router.get("/domains/:slug/limits", authMiddleware, async (c) => {
  const { domain, context } = await loadWorkspace(
    c.req.param("slug")!,
    requestActor(c),
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
      authenticatedActor(c),
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
    data: await updateDomainCommand(
      authenticatedActor(c),
      c.req.param("slug")!,
      revisionHeader(c.req.header("If-Match")),
      {
        name: input.name as string | undefined,
        description: input.description as string | undefined,
        configuration: input.configuration as
          | Record<string, unknown>
          | undefined,
      },
    ),
  });
});
router.post("/domains/:slug/status", authMiddleware, async (c) => {
  const input = await body(c);
  return c.json({
    data: await setDomainStatusCommand(
      authenticatedActor(c),
      c.req.param("slug")!,
      input.status as "active",
      revisionHeader(c.req.header("If-Match")),
    ),
  });
});
router.post("/domains/:slug/join", authMiddleware, async (c) => {
  const input = await body(c);
  return c.json({
    data: await joinDomainCommand(
      authenticatedActor(c),
      c.req.param("slug")!,
      input.reason as string | undefined,
    ),
  });
});
router.get("/domains/:slug/join-requests", authMiddleware, async (c) => {
  return c.json({
    data: await listDomainJoinRequests(
      requestActor(c) as UserActor,
      c.req.param("slug")!,
    ),
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
      data: await reviewJoinRequestCommand(
        authenticatedActor(c),
        c.req.param("slug")!,
        c.req.param("id")!,
        input.approved,
      ),
    });
  },
);
router.get(
  "/domains/:slug/members",
  authMiddleware,
  async (c) => {
    const { page, perPage, offset } = parsePagination(c, {
      defaultPerPage: 25,
    });
    const result = await listDomainMembersPage(
      requestActor(c) as UserActor,
      c.req.param("slug")!,
      {
        offset,
        perPage,
        keyword: c.req.query("keyword"),
      },
    );
    return c.json({
      data: result.data,
      page,
      per_page: perPage,
      pagination: buildPaginationMeta(page, perPage, result.total),
    });
  },
);
router.put(
  "/domains/:slug/members/:userId/role",
  authMiddleware,
  async (c) => {
    const input = await body(c);
    return c.json({
      data: await setMemberRoleCommand(
        authenticatedActor(c),
        c.req.param("slug")!,
        c.req.param("userId")!,
        input.role,
      ),
    });
  },
);
router.delete(
  "/domains/:slug/members/:userId",
  authMiddleware,
  async (c) =>
    c.json({
      data: await removeDomainMemberCommand(
        authenticatedActor(c),
        c.req.param("slug")!,
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
    data: await transferDomainCommand(
      authenticatedActor(c),
      c.req.param("slug")!,
      input.user_id,
    ),
  });
});
router.post("/domains/:slug/invitations", authMiddleware, async (c) => {
  const input = await body(c);
  return c.json({
    data: await createDomainInvitationCommand(
      authenticatedActor(c),
      c.req.param("slug")!,
      input,
    ),
  }, 201);
});
router.get("/domains/:slug/invitations", authMiddleware, async (c) => {
  const pagination = parsePagination(c, { defaultPerPage: 25 });
  const result = await listDomainInvitations(
    requestActor(c) as UserActor,
    c.req.param("slug")!,
    pagination,
  );
  return c.json({
    data: result.data,
    pagination: buildPaginationMeta(
      pagination.page,
      pagination.perPage,
      result.total,
    ),
  });
});
router.delete(
  "/domains/:slug/invitations/:id",
  authMiddleware,
  async (c) =>
    c.json({
      data: await revokeDomainInvitationCommand(
        authenticatedActor(c),
        c.req.param("slug")!,
        c.req.param("id")!,
      ),
    }),
);
router.put("/me/workspace-preference", authMiddleware, async (c) => {
  const input = await body(c);
  if (typeof input.slug !== "string") {
    throw new BadRequestError("工作空间标识非法");
  }
  const { domain } = await loadWorkspace(input.slug, requestActor(c));
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
