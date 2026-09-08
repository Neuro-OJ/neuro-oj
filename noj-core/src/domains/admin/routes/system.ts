/**
 * Admin system 子域路由。
 *
 * 挂载前缀：/api/v1/admin/system（由 domains/admin/index.ts 以 /system 挂载）。
 * 由原 system 域 `admin-announcements.ts`、`admin-audit.ts`、
 * `admin-email-delivery.ts`、`admin-judge-images.ts`、`admin-settings.ts` 迁移而来。
 *
 * 审计分层：
 * - announcements.create/update/delete、settings.update/delete 在 service 层已调用
 *   logAudit，因此保持 service 层为唯一审计源，路由层不重复写。
 * - judge-images.create/update/delete、email-delivery.clear 原先未在 service 层审计，
 *   由路由层 withAudit 作为唯一审计源。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthEnv } from "../../identity/index.ts";
import { parseJsonBody } from "../../../shared/http/request.ts";
import {
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "../../../shared/base/errors.ts";
import { isBootstrap } from "../../../shared/config/settings-registry.ts";
import { assertPermission } from "../../identity/index.ts";
import { withActorContext } from "../../system/index.ts";
import { parsePagination } from "../../../shared/http/pagination.ts";
import {
  createAnnouncement,
  deleteAnnouncement,
  listAdminAnnouncements,
  resolveAnnouncementId,
  updateAnnouncement,
} from "../../system/services/announcements.ts";
import type {
  CreateAnnouncementInput,
  UpdateAnnouncementInput,
} from "../../system/services/announcements.ts";
import { listAuditLogs } from "../../system/services/audit-log.ts";
import type { AuditAction } from "../../system/types/audit-log.ts";
import {
  clearEmailSuppression,
  listEmailSuppressions,
} from "../../system/services/email-delivery/service.ts";
import {
  createJudgeImage,
  deleteJudgeImage,
  listJudgeImages,
  updateJudgeImage,
} from "../../system/services/judge-images.ts";
import type {
  CreateJudgeImageInput,
  UpdateJudgeImageInput,
} from "../../catalog/index.ts";
import {
  cleanupBootstrapRow,
  getSetting,
  listSettings,
  resetSetting,
  updateSetting,
} from "../../system/services/system-settings.ts";
import { getEmailConfigStatus } from "../../system/services/email-status.ts";
import { sendTestEmail } from "../../system/services/email.ts";
import { logger } from "../../../shared/base/logging.ts";
import { withAudit } from "../services/admin-audit.ts";
import type { AuditMeta } from "../types/admin-audit.ts";
import { adminVersionMiddleware } from "../middleware/admin-version.ts";

/** 路由层审计用的临时请求体缓存（withAudit 在 handler 返回后才构建 detail）。 */
const auditBodies = new WeakMap<object, unknown>();

function setAuditBody(c: object, body: unknown): void {
  auditBodies.set(c, body);
}

function getAuditBody<T>(c: object): T | undefined {
  return auditBodies.get(c) as T | undefined;
}

/** 将 AuthEnv handler 适配为 withAudit 接受的 Context handler。 */
function auditRoute(
  meta: AuditMeta,
  handler: (c: Context<AuthEnv>) => Promise<Response>,
) {
  return withAudit(meta)(handler as (c: Context) => Promise<Response>);
}

const router = new Hono<AuthEnv>();

// ── 公告管理（细粒度权限 announcement:manage + RequestContext 注入） ──────
router.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/v1/admin/system/announcements")) {
    await assertPermission(c, "announcement:manage");
    return withActorContext(c, () => next());
  }
  return next();
});

router.get("/announcements", async (c) => {
  await assertPermission(c, "announcement:manage");
  const { page, perPage } = parsePagination(c);
  const isActiveParam = c.req.query("is_active");
  const isActive = isActiveParam === "true"
    ? true
    : isActiveParam === "false"
    ? false
    : undefined;
  const result = await listAdminAnnouncements(page, perPage, isActive);
  return c.json(result);
});

router.post("/announcements", async (c) => {
  await assertPermission(c, "announcement:manage");
  const body = await parseJsonBody<CreateAnnouncementInput>(c);
  const item = await createAnnouncement(body);
  return c.json({ data: item }, 201);
});

router.put("/announcements/:id", async (c) => {
  await assertPermission(c, "announcement:manage");
  const id = await resolveAnnouncementId(c.req.param("id") as string);
  const body = await parseJsonBody<UpdateAnnouncementInput>(c);
  const item = await updateAnnouncement(id, body);
  return c.json({ data: item });
});

router.delete("/announcements/:id", async (c) => {
  await assertPermission(c, "announcement:manage");
  const id = await resolveAnnouncementId(c.req.param("id") as string);
  await deleteAnnouncement(id);
  return c.body(null, 204);
});

// ── 审计日志（只读） ──────────────────────────────────────────────────────
router.get("/audit-logs", async (c) => {
  let page = parseInt(c.req.query("page") ?? "1", 10);
  let perPage = parseInt(c.req.query("per_page") ?? "20", 10);
  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(perPage) || perPage < 1) perPage = 20;
  if (perPage > 100) perPage = 100;

  const result = await listAuditLogs({
    page,
    perPage,
    admin_id: c.req.query("admin_id") || undefined,
    action: (c.req.query("action") || undefined) as AuditAction | undefined,
    from: c.req.query("from") || undefined,
    to: c.req.query("to") || undefined,
  });
  return c.json({ data: result.data, pagination: result.pagination });
});

const AUDIT_ACTIONS: AuditAction[] = [
  "users.role_change",
  "users.ban",
  "users.unban",
  "users.delete",
  "roles.create",
  "roles.update",
  "roles.delete",
  "problems.delete",
  "problems.runtime_config_changed",
  "problems.imported",
  "problems.review",
  "trainings.update",
  "trainings.delete",
  "tags.create",
  "tags.update",
  "tags.delete",
  "tags.merge",
  "submissions.rejudge",
  "submissions.queue_removed",
  "settings.update",
  "ip_ban.create",
  "ip_ban.delete",
  "announcement.create",
  "announcement.update",
  "announcement.delete",
  "contest.ranking_snapshot",
  "contest.create",
  "contest.update",
  "contest.delete",
  "contest.participants_add",
  "contest.participants_remove",
  "contest.kind_change",
  "contest.reset_code",
  "judge_images.create",
  "judge_images.update",
  "judge_images.delete",
  "email_delivery.clear_suppression",
];

router.get("/audit-logs/actions", (c) => {
  return c.json({ data: AUDIT_ACTIONS });
});

// ── 系统设置（service 层已审计） ─────────────────────────────────────────
router.get("/settings", async (c) => {
  const items = await listSettings();
  return c.json({ data: items });
});

router.get("/settings/email/status", (c) => {
  return c.json({ data: getEmailConfigStatus() });
});

router.post("/settings/email/test-send", async (c) => {
  const body = await parseJsonBody<{ to?: string }>(c);
  const to = String(body.to ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new ValidationError("请提供有效的收件邮箱 to");
  }

  const status = getEmailConfigStatus();
  if (!status.configured) {
    throw new BadRequestError(
      `邮件服务未就绪（provider=${status.provider}），请先补全配置：${
        status.missing.join(", ") || "EMAIL_PROVIDER"
      }`,
      "EMAIL_NOT_CONFIGURED",
    );
  }

  try {
    const sent = await sendTestEmail(to);
    return c.json({ data: { sent, provider: status.provider } });
  } catch (err) {
    logger.warn("测试邮件发送失败", {
      module: "admin-settings",
      provider: status.provider,
      error: err,
    });
    throw new ServiceUnavailableError(
      "测试邮件发送失败，请检查邮件服务配置或稍后重试",
    );
  }
});

router.put(
  "/settings/:key",
  adminVersionMiddleware((c) =>
    getSetting(c.req.param("key") as string)?.updatedAt ?? undefined
  ),
  async (c) => {
    const key = c.req.param("key") as string;
    const body = await parseJsonBody<{ value: unknown }>(c);
    if (!("value" in body)) {
      throw new BadRequestError("请求体必须包含 value 字段");
    }
    const item = await updateSetting(key, body.value, c.get("userId"));
    return c.json({ data: item }, 200);
  },
);

router.delete(
  "/settings/:key",
  adminVersionMiddleware((c) =>
    getSetting(c.req.param("key") as string)?.updatedAt ?? undefined
  ),
  async (c) => {
    const key = c.req.param("key") as string;
    const userId = c.get("userId");
    if (isBootstrap(key)) {
      await cleanupBootstrapRow(key, userId);
    } else {
      await resetSetting(key, userId);
    }
    return c.body(null, 204);
  },
);

// ── 评测镜像（路由层审计） ───────────────────────────────────────────────
router.get("/judge-images", async (c) => {
  const items = await listJudgeImages();
  return c.json({ data: items });
});

router.post(
  "/judge-images",
  auditRoute(
    {
      action: "judge_images.create",
      buildDetail: (c) => {
        const body = getAuditBody<CreateJudgeImageInput>(c);
        return {
          action: "judge_images.create",
          image: body?.image ?? "",
          kind: body?.kind,
          mode: body?.mode,
        };
      },
    },
    async (c) => {
      const body = await parseJsonBody<CreateJudgeImageInput>(c);
      if (!body.image?.trim()) {
        throw new BadRequestError("镜像名不能为空");
      }
      setAuditBody(c, body);
      const item = await createJudgeImage(body);
      return c.json({ data: item }, 201);
    },
  ),
);

router.put(
  "/judge-images/:id",
  auditRoute(
    {
      action: "judge_images.update",
      target: (c) => ({ type: "judge_image", id: c.req.param("id")! }),
      buildDetail: (c) => {
        const body = getAuditBody<
          { id?: string; input?: UpdateJudgeImageInput }
        >(c);
        return {
          action: "judge_images.update",
          id: body?.id ?? "",
          image: body?.input?.image,
          kind: body?.input?.kind,
          mode: body?.input?.mode,
          description: body?.input?.description,
        };
      },
    },
    async (c) => {
      const id = c.req.param("id") as string;
      const body = await parseJsonBody<UpdateJudgeImageInput>(c);
      setAuditBody(c, { id, input: body });
      const item = await updateJudgeImage(id, body);
      return c.json({ data: item }, 200);
    },
  ),
);

router.delete(
  "/judge-images/:id",
  auditRoute(
    {
      action: "judge_images.delete",
      target: (c) => ({ type: "judge_image", id: c.req.param("id")! }),
      buildDetail: (c) => ({
        action: "judge_images.delete",
        id: c.req.param("id")!,
      }),
    },
    async (c) => {
      const id = c.req.param("id") as string;
      await deleteJudgeImage(id);
      return c.body(null, 204);
    },
  ),
);

// ── 邮件送达抑制（路由层审计） ───────────────────────────────────────────
router.get("/email-delivery/suppressions", async (c) => {
  const rawLimit = Number(c.req.query("limit") ?? "100");
  return c.json({
    data: await listEmailSuppressions(
      Number.isFinite(rawLimit) ? rawLimit : 100,
    ),
  });
});

router.post(
  "/email-delivery/suppressions/:id/clear",
  auditRoute(
    {
      action: "email_delivery.clear_suppression",
      target: (c) => ({
        type: "email_suppression",
        id: c.req.param("id")!,
      }),
      buildDetail: (c) => ({
        action: "email_delivery.clear_suppression",
        id: c.req.param("id")!,
      }),
    },
    async (c) => {
      const cleared = await clearEmailSuppression(
        c.req.param("id")!,
        c.get("userId"),
      );
      if (!cleared) throw new NotFoundError("抑制记录不存在或已经解除");
      return c.json({ data: { cleared: true } });
    },
  ),
);

export default router;
