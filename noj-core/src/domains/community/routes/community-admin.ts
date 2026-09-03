import { Hono } from "hono";
import type { Next } from "hono";
import { parseJsonBody } from "../../../lib/request.ts";
import {
  BadRequestError,
  ForbiddenError,
} from "./../../../shared/base/errors.ts";
import {
  assertPermission,
  checkPermission,
  getUserPermissions,
} from "../../../lib/permissions.ts";
import {
  COMMUNITY_PRESETS,
  MODERATION_STATUSES,
} from "../../../types/community.ts";
import { authMiddleware, getUserBanState } from "../../../middleware/auth.ts";
import type { OptionalAuthEnv } from "../../../middleware/auth.ts";
import {
  applyCommunityPreset,
  banUser,
  changeCommentStatus,
  changePostStatus,
  createBoard,
  createSanction,
  deleteBoardRoleGrant,
  getLatestActiveBanId,
  getReportBanScope,
  getReportImageBytes,
  getReportTarget,
  listBoardRoleGrants,
  listPendingComments,
  listReports,
  listSanctions,
  listUserSanctions,
  reopenReport,
  resolvePostId,
  resolveReport,
  revokeSanction,
  togglePostFlag,
  updateBoard,
  updateBoardRoleGrant,
} from "../services/community/community.ts";
import { resolveUserId } from "../../identity/index.ts";
import {
  getReviewQueueDetail,
  listReviewQueue,
  resolveReviewQueue,
} from "../../content-review/index.ts";

/**
 * 社区管理路由（挂载前缀 /api/v1/community，见 app.ts）。
 *
 * 提供（相对路径 /admin/*）：
 * - /admin/preset/:preset                     应用社区预设（system:settings）
 * - /admin/boards                           板块管理（community_board:manage）
 * - /admin/boards/:boardId/role-grants       板块角色授权
 * - /admin/reports                          举报处理（resolve/dismiss）
 * - /admin/posts/:postId/:status            帖子状态（published/hidden/deleted）
 * - /admin/comments/:commentId/:status      评论状态
 * - /admin/comments/pending                 待审核评论列表
 * - /admin/posts/:postId/:flag              锁定/置顶（community_moderation:lock）
 * - /admin/sanctions                        社区处罚（community_moderation:sanction）
 * - /admin/users/:userId/sanctions          用户处罚记录
 *
 * 组级守卫 `requireCommunityModeration` 集中在文件顶部注册：
 * 具备 `community_moderation:review` 权限的审核员可进入，各端点再按操作
 * 细分权限（lock / sanction / board / system 等）。
 */
const router = new Hono<OptionalAuthEnv>();

/**
 * 从请求上下文读取当前登录用户 UUID，未登录时抛出 ForbiddenError。
 * @param c Hono 上下文（含 userId）。
 * @returns 当前用户 UUID。
 * @throws {ForbiddenError} 未登录时抛出。
 */
function userId(c: { get: (key: "userId") => string | undefined }): string {
  const id = c.get("userId");
  if (!id) throw new ForbiddenError("请先登录");
  return id;
}

/**
 * 社区管理路由守卫：具备 `community_moderation:review` 权限的审核员可进入；
 * 各端点再按操作细分（lock / sanction / board 等）。
 */
async function requireCommunityModeration(
  c: Parameters<typeof checkPermission>[0],
  next: Next,
) {
  if (!(await checkPermission(c, "community_moderation:review"))) {
    throw new ForbiddenError("权限不足");
  }
  await next();
}

/**
 * 管理路由组守卫：/admin/* 全部需登录且具备社区审核权限（requireCommunityModeration）。
 */
router.use("/admin/*", authMiddleware, requireCommunityModeration);

/**
 * POST /admin/preset/:preset — 应用社区预设（public / private / knowledge）。
 * 权限：system:settings（仅管理员）。
 * 响应：{ data: 应用后的社区配置 }。
 */
router.post("/admin/preset/:preset", async (c) => {
  // 预设属于系统配置，仅管理员可应用
  await assertPermission(c, "system:settings");
  const preset = c.req.param("preset");
  if (!(COMMUNITY_PRESETS as readonly string[]).includes(preset)) {
    throw new BadRequestError("无效社区预设");
  }
  return c.json({
    data: await applyCommunityPreset(
      userId(c),
      preset as "public" | "private" | "knowledge",
    ),
  });
});
/**
 * POST /admin/boards — 创建社区板块。
 * 权限：community_board:manage。body：{ slug, name, description?, sort_order? }。
 * 响应：201 { data: 新建板块 }。
 */
router.post("/admin/boards", async (c) => {
  // 板块管理：community_board:manage（默认仅 admin 角色被授予）
  await assertPermission(c, "community_board:manage");
  const body = await parseJsonBody<
    { slug?: string; name?: string; description?: string; sort_order?: number }
  >(c);
  if (!body.slug || !body.name) {
    throw new BadRequestError("板块 slug 和名称不能为空");
  }
  return c.json({
    data: await createBoard({
      slug: body.slug,
      name: body.name,
      description: body.description,
      sort_order: body.sort_order,
    }),
  }, 201);
});
/**
 * PATCH /admin/boards/:boardId — 更新社区板块。
 * 权限：community_board:manage。body：部分板块字段。
 * 响应：{ data: 更新后的板块 }。
 */
router.patch(
  "/admin/boards/:boardId",
  async (c) => {
    // 板块管理：community_board:manage
    await assertPermission(c, "community_board:manage");
    return c.json({
      data: await updateBoard(c.req.param("boardId"), await parseJsonBody(c)),
    });
  },
);
/**
 * GET /admin/boards/:boardId/role-grants — 列出板块的角色授权。
 * 权限：community_board:manage。
 * 响应：{ data: 角色授权列表 }。
 */
router.get(
  "/admin/boards/:boardId/role-grants",
  async (c) => {
    await assertPermission(c, "community_board:manage");
    return c.json({ data: await listBoardRoleGrants(c.req.param("boardId")) });
  },
);
/**
 * PUT /admin/boards/:boardId/role-grants/:roleId — 更新（或创建）板块角色授权。
 * 权限：community_board:manage。body：{ can_read?, can_post?, can_moderate? }。
 * 响应：{ data: 更新后的角色授权 }。
 */
router.put("/admin/boards/:boardId/role-grants/:roleId", async (c) => {
  await assertPermission(c, "community_board:manage");
  const body = await parseJsonBody<{
    can_read?: boolean;
    can_post?: boolean;
    can_moderate?: boolean;
  }>(c);
  return c.json({
    data: await updateBoardRoleGrant(
      c.req.param("boardId"),
      c.req.param("roleId"),
      body,
    ),
  });
});
/**
 * DELETE /admin/boards/:boardId/role-grants/:roleId — 删除板块角色授权。
 * 权限：community_board:manage。响应：204。
 */
router.delete("/admin/boards/:boardId/role-grants/:roleId", async (c) => {
  await assertPermission(c, "community_board:manage");
  await deleteBoardRoleGrant(c.req.param("boardId"), c.req.param("roleId"));
  return c.body(null, 204);
});
/**
 * GET /admin/reports — 列出举报工单。
 * 权限：社区审核。query：status（pending/resolved/dismissed/all，默认 pending）。
 * 响应：{ data: 举报列表 }。
 */
router.get(
  "/admin/reports",
  async (c) => {
    const status = c.req.query("status") as
      | "pending"
      | "resolved"
      | "dismissed"
      | "all"
      | undefined;
    const s = status ?? "pending";
    if (!["pending", "resolved", "dismissed", "all"].includes(s)) {
      throw new BadRequestError("无效举报状态");
    }
    return c.json({ data: await listReports(s) });
  },
);
/**
 * GET /admin/comments/pending — 列出待审核评论。
 * 权限：社区审核。query：limit。
 * 响应：{ data: 待审核评论列表 }。
 */
router.get(
  "/admin/comments/pending",
  async (c) =>
    c.json({
      data: await listPendingComments(Number(c.req.query("limit") ?? 50)),
    }),
);
/**
 * POST /admin/reports/:reportId/reopen — 重新开启举报（撤销处理/驳回）。
 * 权限：社区审核；涉及封禁/禁言撤销时需更高权限。
 * 响应：{ data: 更新后的举报 }。
 */
router.post("/admin/reports/:reportId/reopen", async (c) => {
  const reportId = c.req.param("reportId");
  // 撤销处理若涉及解除封禁或社区禁言，需更高级的社区处罚权限（防止审核员越权解封）
  const target = await getReportTarget(reportId);
  if (target.report.ban_id || target.report.sanction_id) {
    await assertPermission(c, "community_moderation:sanction");
  }
  // 若撤销的是 platform 级封禁（限制登录/评测），仅管理员（admin:full_access）可操作
  if (target.report.ban_id) {
    const ban = await getReportBanScope(reportId);
    if (ban === "platform") {
      await assertPermission(c, "admin:full_access");
    }
  }
  return c.json({
    data: await reopenReport(reportId),
  });
});
/**
 * POST /admin/reports/:reportId/:status — 处理或驳回举报。
 * 权限：社区审核；封禁需 community_moderation:sanction，平台级封禁需 admin:full_access。
 * body：{ resolution?, action?, scope?, expires_at? }。
 * 响应：{ data: 更新后的举报 }。
 */
router.post("/admin/reports/:reportId/:status", async (c) => {
  const status = c.req.param("status");
  if (status !== "resolved" && status !== "dismissed") {
    throw new BadRequestError("无效举报状态");
  }
  const body = await parseJsonBody<{
    resolution?: string;
    action?: "remove_content" | "ban";
    scope?: "platform" | "social";
    expires_at?: string;
  }>(c);
  const reportId = c.req.param("reportId");
  const actorId = userId(c);

  // 驳回：仅标记，不处理内容/用户
  if (status === "dismissed") {
    return c.json({
      data: await resolveReport(
        reportId,
        actorId,
        "dismissed",
        body.resolution,
      ),
    });
  }

  // 处理（resolved）：被处罚用户必须从举报目标派生，不允许客户端指定任意用户（越权封禁）
  const target = await getReportTarget(reportId);
  const targetUserId = target.post?.author_id ?? target.comment?.author_id ??
    target.message?.sender_id;
  if (!targetUserId) throw new BadRequestError("举报目标用户不存在");

  // 审核员不能借举报流程对管理员/其他审核员施加社交封禁（需 admin:full_access）
  if (body.action === "ban" && body.scope !== "platform") {
    const targetPerms = await getUserPermissions(targetUserId);
    const targetIsPrivileged = targetPerms.has("admin:full_access") ||
      targetPerms.has("community_moderation:review");
    if (
      targetIsPrivileged && !(await checkPermission(c, "admin:full_access"))
    ) {
      throw new ForbiddenError("无权对管理员/审核员执行社交封禁");
    }
  }

  let banId: string | undefined;
  if (body.action === "ban") {
    // 封禁属于更高级别权限（社区处罚 / 管理员）
    await assertPermission(c, "community_moderation:sanction");
    // 平台级封禁（限制登录/评测）超出社区处罚本意，仅允许管理员（admin:full_access）
    if (body.scope === "platform") {
      await assertPermission(c, "admin:full_access");
    }
    // 防止封禁降级：若目标用户已有 platform 活跃封禁，social 封禁会覆盖并降级，需管理员处理
    if (body.scope !== "platform") {
      const existing = await getUserBanState(targetUserId);
      if (existing.banned && existing.scope === "platform") {
        throw new BadRequestError(
          "该用户已被平台级封禁，如需调整请使用管理员封禁功能",
        );
      }
    }
    const created = await banUser(
      targetUserId,
      body.resolution || "因举报被处罚",
      body.expires_at || null,
      actorId,
      body.scope ?? "social",
    );
    banId = created.active_ban
      ? await getLatestActiveBanId(targetUserId)
      : undefined;
  } else {
    // 默认移除内容：隐藏帖子或评论；私信消息无公开内容可隐藏，仅记录处理
    const reason = body.resolution || "被举报隐藏";
    if (target.post) {
      await changePostStatus(target.post.id, actorId, "hidden", reason);
    } else if (target.comment) {
      await changeCommentStatus(target.comment.id, actorId, "hidden", reason);
    }
  }
  return c.json({
    data: await resolveReport(
      reportId,
      actorId,
      "resolved",
      body.resolution || (body.action === "ban" ? "已封禁" : "已移除内容"),
      banId,
    ),
  });
});
/**
 * POST /admin/posts/:postId/:status — 变更帖子状态（published/hidden/deleted）。
 * 权限：社区审核。body：{ reason? }。
 * 响应：{ data: 更新后的帖子 }。
 */
router.post("/admin/posts/:postId/:status", async (c) => {
  const status = c.req.param("status");
  if (!(MODERATION_STATUSES as readonly string[]).includes(status)) {
    throw new BadRequestError("无效内容状态");
  }
  const body = await parseJsonBody<{ reason?: string }>(c);
  const postId = await resolvePostId(c.req.param("postId") as string);
  return c.json({
    data: await changePostStatus(
      postId,
      userId(c),
      status as "published" | "hidden" | "deleted",
      body.reason,
    ),
  });
});
/**
 * POST /admin/comments/:commentId/:status — 变更评论状态（published/hidden/deleted）。
 * 权限：社区审核。body：{ reason? }。
 * 响应：{ data: 更新后的评论 }。
 */
router.post("/admin/comments/:commentId/:status", async (c) => {
  const status = c.req.param("status");
  if (!(MODERATION_STATUSES as readonly string[]).includes(status)) {
    throw new BadRequestError("无效内容状态");
  }
  const body = await parseJsonBody<{ reason?: string }>(c);
  return c.json({
    data: await changeCommentStatus(
      c.req.param("commentId"),
      userId(c),
      status as "published" | "hidden" | "deleted",
      body.reason,
    ),
  });
});
/**
 * POST /admin/posts/:postId/:flag — 锁定或置顶帖子。
 * 权限：community_moderation:lock。body：{ value? }。
 * 响应：{ data: 更新后的帖子 }。
 */
router.post("/admin/posts/:postId/:flag", async (c) => {
  // 锁定/置顶：community_moderation:lock
  await assertPermission(c, "community_moderation:lock");
  const flag = c.req.param("flag");
  if (flag !== "lock" && flag !== "pin") {
    throw new BadRequestError("无效内容操作");
  }
  const body = await parseJsonBody<{ value?: boolean }>(c);
  const postId = await resolvePostId(c.req.param("postId") as string);
  return c.json({
    data: await togglePostFlag(
      postId,
      userId(c),
      flag === "lock" ? "is_locked" : "is_pinned",
      body.value === true,
    ),
  });
});
/**
 * GET /admin/sanctions — 列出全部社区处罚。
 * 权限：社区审核。
 * 响应：{ data: 社区处罚列表 }。
 */
router.get(
  "/admin/sanctions",
  async (c) => c.json({ data: await listSanctions() }),
);
/**
 * POST /admin/sanctions — 创建社区处罚（禁言）。
 * 权限：community_moderation:sanction。body：{ user_id, reason, expires_at? }。
 * 响应：201 { data: 新建处罚 }。
 */
router.post("/admin/sanctions", async (c) => {
  // 社区处罚：community_moderation:sanction
  await assertPermission(c, "community_moderation:sanction");
  const body = await parseJsonBody<
    { user_id?: string; reason?: string; expires_at?: string }
  >(c);
  if (!body.user_id || !body.reason) {
    throw new BadRequestError("缺少用户或处罚原因");
  }
  const targetUserId = await resolveUserId(body.user_id);
  return c.json({
    data: await createSanction(
      userId(c),
      targetUserId,
      body.reason,
      body.expires_at,
    ),
  }, 201);
});
/**
 * DELETE /admin/sanctions/:sanctionId — 撤销社区处罚。
 * 权限：community_moderation:sanction。
 * 响应：{ data: 撤销后的处罚 }。
 */
router.delete(
  "/admin/sanctions/:sanctionId",
  async (c) => {
    // 撤销社区处罚：community_moderation:sanction
    await assertPermission(c, "community_moderation:sanction");
    return c.json({
      data: await revokeSanction(userId(c), c.req.param("sanctionId")),
    });
  },
);
/**
 * GET /admin/users/:userId/sanctions — 列出指定用户的社区处罚历史。
 * 权限：社区审核。:userId 可为 username 或 UUID。
 * 响应：{ data: 处罚历史列表 }。
 */
router.get(
  "/admin/users/:userId/sanctions",
  async (c) => {
    const targetUserId = await resolveUserId(c.req.param("userId") as string);
    return c.json({ data: await listUserSanctions(targetUserId) });
  },
);

// 审核员读取举报附带的私信图片（审核员非会话参与者，不能走 conversations 图片端点）
router.get(
  "/admin/reports/images/:conversationId/:messageId",
  async (c) => {
    const { conversationId, messageId } = c.req.param();
    const { bytes, contentType, etag } = await getReportImageBytes(
      conversationId,
      messageId,
    );
    return new Response(bytes as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=86400",
        "ETag": etag,
      },
    });
  },
);

/**
 * GET /admin/content-review — 统一人工审查队列（issue #413）。
 * 权限：社区审核。
 * query：status / content_type / channel / from / to / page / per_page。
 * 响应：{ data, pagination }。
 */
router.get(
  "/admin/content-review",
  async (c) => {
    const parsePage = (raw: string | undefined, fallback: number) => {
      const n = Number(raw ?? fallback);
      return Number.isInteger(n) && n >= 1 ? n : fallback;
    };
    const status = c.req.query("status");
    const content_type = c.req.query("content_type");
    const channel = c.req.query("channel");
    const validStatus = [
      "pending_review",
      "approved",
      "rejected",
      "reviewed",
      "dismissed",
    ];
    if (status && !validStatus.includes(status)) {
      throw new BadRequestError("无效审查状态");
    }
    if (
      content_type && !["post", "comment", "message"].includes(content_type)
    ) {
      throw new BadRequestError("无效内容类型");
    }
    if (channel && !["ugc", "dm"].includes(channel)) {
      throw new BadRequestError("无效来源渠道");
    }
    const result = await listReviewQueue({
      status: status as never || undefined,
      content_type: content_type as never || undefined,
      channel: channel as never || undefined,
      from: c.req.query("from") ?? undefined,
      to: c.req.query("to") ?? undefined,
      page: parsePage(c.req.query("page"), 1),
      perPage: parsePage(c.req.query("per_page"), 20),
    });
    return c.json({
      data: result.data,
      pagination: {
        page: result.page,
        per_page: result.per_page,
        total: result.total,
        total_pages: result.total_pages,
      },
    });
  },
);
/**
 * GET /admin/content-review/:id — 审查队列详情（附目标内容上下文）。
 * 权限：社区审核。
 */
router.get("/admin/content-review/:id", async (c) => {
  const detail = await getReviewQueueDetail(c.req.param("id"));
  return c.json({
    data: {
      ...detail.queue,
      context: detail.context,
    },
  });
});
/**
 * POST /admin/content-review/:id/:status — 处置/驳回统一审查队列。
 * 权限：社区审核；隐藏内容或封禁操作走既有内容/处罚端点（本端点仅记录处置留痕）。
 * body：{ resolution, action? }（action：record_only / hide_post / hide_comment / dismiss）。
 * 响应：{ data: 更新后的记录 }。
 */
router.post("/admin/content-review/:id/:status", async (c) => {
  const status = c.req.param("status");
  if (status !== "reviewed" && status !== "dismissed") {
    throw new BadRequestError("无效审查状态");
  }
  const body = await parseJsonBody<{ resolution?: string; action?: string }>(c);
  const action = status === "dismissed"
    ? "dismiss"
    : body.action ?? "record_only";
  const record = await resolveReviewQueue(
    c.req.param("id"),
    userId(c),
    status,
    action,
    body.resolution ?? (status === "dismissed" ? "无需处置" : "已人工复核"),
  );
  return c.json({ data: record });
});

export default router;
