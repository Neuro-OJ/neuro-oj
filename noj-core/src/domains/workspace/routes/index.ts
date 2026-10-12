import { Hono } from "hono";
import { eq } from "drizzle-orm";
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
import {
  domainCreationRequests,
  domainJoinRequests,
  userWorkspacePreferences,
} from "../../../shared/db/schema.ts";
import type {
  DomainConfiguration,
  DomainPreset,
  DomainRole,
} from "../../../shared/workspace/types.ts";
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
  revokeDomainInvitation,
} from "../services/invitations.ts";
import {
  joinDomain,
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
import { configurationDiff, presetConfiguration } from "../types.ts";

const router = new Hono<OptionalAuthEnv>();

function revisionHeader(value: string | undefined) {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new AppError("请携带 If-Match 配置版本", 428, "REVISION_REQUIRED");
  }
  return Number(value);
}
function presetValue(value: unknown): DomainPreset {
  if (
    typeof value !== "string" ||
    !["community", "education", "team", "custom"].includes(value)
  ) throw new BadRequestError("模板非法");
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
  "/admin/instance/domain-creation-requests",
  authMiddleware,
  requireAdmin(),
  async (c) =>
    c.json({
      data: await getDb().select().from(domainCreationRequests).orderBy(
        domainCreationRequests.created_at,
      ).limit(100),
    }),
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
router.get("/domains/:slug", optionalAuthMiddleware, async (c) => {
  const { domain, context } = await loadWorkspace(
    c.req.param("slug")!,
    c.var.userId ?? null,
  );
  return c.json({
    data: { ...domain, permissions: [...context.domainPermissions] },
  });
});
router.patch("/domains/:slug", authMiddleware, async (c) => {
  const input = await body(c);
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
router.post("/domains/:slug/preset-preview", authMiddleware, async (c) => {
  const input = await body(c);
  const { domain, context } = await loadWorkspace(
    c.req.param("slug")!,
    c.var.userId!,
  );
  assertWorkspacePermission(context, "domain:settings");
  const configuration = presetConfiguration(presetValue(input.preset));
  return c.json({
    data: {
      revision: domain.revision,
      configuration,
      changes: configurationDiff(domain.configuration, configuration),
    },
  });
});
router.post("/domains/:slug/preset-apply", authMiddleware, async (c) => {
  const input = await body(c);
  return c.json({
    data: await updateDomain(
      c.req.param("slug")!,
      c.var.userId!,
      revisionHeader(c.req.header("If-Match")),
      { configuration: presetConfiguration(presetValue(input.preset)) },
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
  const { domain, context } = await loadWorkspace(
    c.req.param("slug")!,
    c.var.userId!,
  );
  assertWorkspacePermission(context, "domain:members");
  return c.json({
    data: await getDb().select().from(domainJoinRequests).where(
      eq(domainJoinRequests.domain_id, domain.id),
    ).orderBy(domainJoinRequests.created_at).limit(100),
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
  async (c) =>
    c.json({
      data: await listDomainMembers(c.req.param("slug")!, c.var.userId!),
    }),
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
