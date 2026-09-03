import { Hono } from "hono";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "./../../../shared/base/errors.ts";
import { assertPermission, checkPermission } from "./../../identity/index.ts";
import { resolveUserId } from "../../identity/index.ts";
import {
  authMiddleware,
  type OptionalAuthEnv,
  optionalAuthMiddleware,
} from "./../../identity/index.ts";
import type {
  CommunityPostInput,
  CommunityPostType,
} from "./../types/community.ts";
import {
  assertCommunityEnabled,
  assertCommunityWritable,
  changePostStatus,
  countPostsByType,
  createComment,
  createPost,
  createReport,
  deleteComment,
  getCommunityConfig,
  getNotificationUnreadCount,
  getPost,
  getReportDetail,
  getReportMessageHistory,
  hasAcceptedSolution,
  listBoards,
  listBookmarks,
  listComments,
  listFeed,
  listNotifications,
  listPosts,
  markNotificationRead,
  markNotificationsRead,
  resolvePostId,
  resolveProblemId,
  toggleBookmark,
  toggleCommentLike,
  toggleFollow,
  togglePostLike,
  updateActivityVisibility,
  updateComment,
  updatePost,
} from "../services/community/community.ts";

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
 * 判断当前请求用户是否为社区审核员（具备 community_moderation:review 权限）。
 * @param c Hono 上下文。
 * @returns 是否为审核员。
 */
async function isModerator(
  c: Parameters<typeof checkPermission>[0],
): Promise<boolean> {
  // admin:full_access 通配放行由 checkPermission 内部处理
  return await checkPermission(c, "community_moderation:review");
}

/** 访客读社区守卫：guest_read_enabled 关闭时未登录用户禁止访问 */
function requireGuestRead(
  c: { get: (key: "userId") => string | undefined },
): void {
  if (!getCommunityConfig().guest_read_enabled && !c.get("userId")) {
    throw new UnauthorizedError("登录后可查看社区");
  }
}

/**
 * 断言当前用户具备创建指定类型帖子的权限。
 * @param c Hono 上下文。
 * @param type 帖子类型（solution / discussion / moment）。
 * @throws {ForbiddenError} 无对应创建权限时抛出。
 */
async function requirePostPermission(
  c: Parameters<typeof assertPermission>[0],
  type: CommunityPostType,
): Promise<void> {
  await assertPermission(c, `community:create_${type}`);
}

/**
 * GET /config — 获取社区配置与当前用户权限。
 * 认证：可选（optionalAuthMiddleware）。未登录时仅返回配置，不返回权限。
 * 响应：{ data: { ...config, permissions } }。
 */
router.get("/config", optionalAuthMiddleware, async (c) => {
  const config = getCommunityConfig();
  const loggedIn = !!c.get("userId");
  if (!config.enabled) return c.json({ data: { ...config, permissions: {} } });
  const permissions = loggedIn
    ? {
      solution: await checkPermission(c, "community:create_solution"),
      discussion: await checkPermission(c, "community:create_discussion"),
      moment: await checkPermission(c, "community:create_moment"),
      comment: await checkPermission(c, "community:comment"),
      react: await checkPermission(c, "community:react"),
      follow: await checkPermission(c, "community:follow"),
      report: await checkPermission(c, "community:report"),
      moderate: await isModerator(c),
    }
    : {};
  return c.json({ data: { ...config, permissions } });
});

/**
 * GET /boards — 获取社区板块列表。
 * 认证：可选。需讨论模块开启且满足访客读守卫。
 * 响应：{ data: 板块列表 }。
 */
router.get("/boards", optionalAuthMiddleware, async (c) => {
  assertCommunityEnabled("discussions_enabled");
  requireGuestRead(c);
  return c.json({ data: await listBoards() });
});

/**
 * GET /posts — 获取社区帖子列表（支持筛选与分页）。
 * 认证：可选。query：type、q、problem_id、board_id、author_id、cursor、limit。
 * 响应：{ data, next_cursor }。
 */
router.get("/posts", optionalAuthMiddleware, async (c) => {
  const type = c.req.query("type") as CommunityPostType | undefined;
  const query = c.req.query("q")?.trim();
  if (type && !["solution", "discussion", "moment"].includes(type)) {
    throw new BadRequestError("无效内容类型");
  }
  if (query && query.length > 100) {
    throw new BadRequestError("搜索关键词最多 100 个字符");
  }
  assertCommunityEnabled(
    type === "solution"
      ? "solutions_enabled"
      : type === "discussion"
      ? "discussions_enabled"
      : type === "moment"
      ? "moments_enabled"
      : undefined,
  );
  requireGuestRead(c);
  const moderator = c.get("userId") ? await isModerator(c) : false;
  return c.json(
    await listPosts({
      type,
      problemId: c.req.query("problem_id"),
      boardId: c.req.query("board_id"),
      authorId: c.req.query("author_id"),
      query,
      cursor: c.req.query("cursor"),
      limit: Number(c.req.query("limit") ?? 20),
      viewerId: c.get("userId"),
      moderator,
    }),
  );
});

/**
 * GET /bookmarks — 获取当前用户收藏的帖子列表。
 * 认证：必填（authMiddleware）。query：cursor、limit。
 * 响应：{ data, next_cursor }。
 */
router.get("/bookmarks", authMiddleware, async (c) => {
  return c.json(
    await listBookmarks(
      userId(c),
      c.req.query("cursor"),
      Number(c.req.query("limit") ?? 20),
    ),
  );
});

/**
 * GET /posts/counts — 获取各类型已发布帖子的数量统计。
 * 认证：可选。需社区开启且满足访客读守卫。
 * 响应：{ data: { solution, discussion, moment } }。
 */
router.get("/posts/counts", optionalAuthMiddleware, async (c) => {
  assertCommunityEnabled();
  requireGuestRead(c);
  return c.json({ data: await countPostsByType() });
});

/**
 * 题解发布资格：题目页发布入口据此展示启用/禁用态与原因。
 * 返回题解模块开关、门槛是否开启、当前用户是否已通过（finished 且 score>0）以及能否发布。
 */
router.get("/solutions/eligibility", authMiddleware, async (c) => {
  const problemRef = c.req.query("problem_id");
  if (!problemRef) throw new BadRequestError("缺少 problem_id");
  const problemId = await resolveProblemId(problemRef);
  if (!problemId) throw new NotFoundError("题目不存在");
  const actorId = userId(c);
  const config = getCommunityConfig();
  const requiresAccepted = config.solution_requires_accepted;
  const accepted = requiresAccepted
    ? await hasAcceptedSolution(actorId, problemId)
    : true;
  const canCreate = config.solutions_enabled &&
    (!config.read_only || await isModerator(c)) &&
    (await checkPermission(c, "community:create_solution")) &&
    (accepted || await isModerator(c));
  return c.json({
    data: {
      enabled: config.solutions_enabled,
      requires_accepted: requiresAccepted,
      accepted,
      can_create: canCreate,
    },
  });
});

/**
 * GET /posts/:postId — 获取帖子详情。
 * 认证：可选。需社区开启且满足访客读守卫。
 * 响应：{ data: 帖子详情 }。
 */
router.get("/posts/:postId", optionalAuthMiddleware, async (c) => {
  assertCommunityEnabled();
  requireGuestRead(c);
  const postId = await resolvePostId(c.req.param("postId") as string);
  return c.json({
    data: await getPost(
      postId,
      c.get("userId"),
      c.get("userId") ? await isModerator(c) : false,
    ),
  });
});

/**
 * POST /posts — 创建社区帖子（题解 / 讨论 / 短动态）。
 * 认证：必填。body：CommunityPostInput（type、title、content、problem_id、board_id 等）。
 * 响应：201 { data: 新建帖子 }。
 */
router.post("/posts", authMiddleware, async (c) => {
  const actorId = userId(c);
  const input = await parseJsonBody<CommunityPostInput>(c);
  if (!input || !["solution", "discussion", "moment"].includes(input.type)) {
    throw new BadRequestError("无效内容类型");
  }
  await requirePostPermission(c, input.type);
  await assertCommunityWritable(actorId, await isModerator(c));
  const post = await createPost(actorId, input, await isModerator(c));
  return c.json({ data: post }, 201);
});

/**
 * PATCH /posts/:postId — 更新帖子标题/内容。
 * 认证：必填。body：{ title?, content? }。
 * 响应：{ data: 更新后的帖子 }。
 */
router.patch("/posts/:postId", authMiddleware, async (c) => {
  const actorId = userId(c);
  const postId = await resolvePostId(c.req.param("postId") as string);
  await assertCommunityWritable(actorId, await isModerator(c));
  const input = await parseJsonBody<
    Partial<Pick<CommunityPostInput, "title" | "content">>
  >(c);
  return c.json({
    data: await updatePost(
      postId,
      actorId,
      await isModerator(c),
      input,
    ),
  });
});

/**
 * DELETE /posts/:postId — 删除帖子（软删除，状态置为 deleted）。
 * 认证：必填。仅作者或审核员可删除。
 * 响应：{ data: 更新后的帖子 }。
 */
router.delete("/posts/:postId", authMiddleware, async (c) => {
  const actorId = userId(c);
  const postId = await resolvePostId(c.req.param("postId") as string);
  const post = await getPost(
    postId,
    actorId,
    await isModerator(c),
  );
  if (post.post.author_id !== actorId && !(await isModerator(c))) {
    throw new ForbiddenError("无权删除该内容");
  }
  await assertCommunityWritable(actorId, await isModerator(c), {
    allowSocialBan: true,
  });
  return c.json({
    data: await changePostStatus(
      postId,
      actorId,
      "deleted",
    ),
  });
});

/**
 * GET /posts/:postId/comments — 获取帖子的评论列表。
 * 认证：可选。需满足访客读守卫。
 * 响应：{ data: 评论列表 }。
 */
router.get(
  "/posts/:postId/comments",
  optionalAuthMiddleware,
  async (c) => {
    requireGuestRead(c);
    const postId = await resolvePostId(c.req.param("postId") as string);
    return c.json({
      data: await listComments(
        postId,
        c.get("userId"),
        c.get("userId") ? await isModerator(c) : false,
      ),
    });
  },
);
/**
 * POST /posts/:postId/comments — 创建评论（或回复一级评论）。
 * 认证：必填。body：{ content, parent_id? }。
 * 响应：201 { data: 新建评论 }。
 */
router.post("/posts/:postId/comments", authMiddleware, async (c) => {
  const actorId = userId(c);
  const postId = await resolvePostId(c.req.param("postId") as string);
  await assertPermission(c, "community:comment");
  await assertCommunityWritable(actorId, await isModerator(c));
  const body = await parseJsonBody<{ content?: string; parent_id?: string }>(c);
  if (!body.content) throw new BadRequestError("缺少评论内容");
  return c.json({
    data: await createComment(
      actorId,
      postId,
      body.content,
      body.parent_id,
      await isModerator(c),
    ),
  }, 201);
});

/**
 * PATCH /comments/:commentId — 编辑评论内容。
 * 认证：必填。body：{ content }。仅作者或审核员可编辑。
 * 响应：{ data: 更新后的评论 }。
 */
router.patch("/comments/:commentId", authMiddleware, async (c) => {
  const actorId = userId(c);
  await assertCommunityWritable(actorId, await isModerator(c));
  const body = await parseJsonBody<{ content?: string }>(c);
  if (!body.content) throw new BadRequestError("缺少评论内容");
  return c.json({
    data: await updateComment(
      c.req.param("commentId") as string,
      actorId,
      await isModerator(c),
      body.content,
    ),
  });
});
/**
 * DELETE /comments/:commentId — 删除评论（软删除）。
 * 认证：必填。仅作者或审核员可删除。
 * 响应：{ data: 更新后的评论 }。
 */
router.delete("/comments/:commentId", authMiddleware, async (c) => {
  const actorId = userId(c);
  await assertCommunityWritable(actorId, await isModerator(c), {
    allowSocialBan: true,
  });
  return c.json({
    data: await deleteComment(
      c.req.param("commentId") as string,
      actorId,
      await isModerator(c),
    ),
  });
});

/**
 * POST /posts/:postId/like — 切换帖子点赞状态。
 * 认证：必填。需 community:react 权限。
 * 响应：{ data: { liked } }。
 */
router.post("/posts/:postId/like", authMiddleware, async (c) => {
  const actorId = userId(c);
  const postId = await resolvePostId(c.req.param("postId") as string);
  await assertPermission(c, "community:react");
  await assertCommunityWritable(actorId, await isModerator(c));
  return c.json({
    data: {
      liked: await togglePostLike(actorId, postId),
    },
  });
});
/**
 * POST /posts/:postId/bookmark — 切换帖子收藏状态。
 * 认证：必填。需 community:react 权限。
 * 响应：{ data: { bookmarked } }。
 */
router.post("/posts/:postId/bookmark", authMiddleware, async (c) => {
  const actorId = userId(c);
  const postId = await resolvePostId(c.req.param("postId") as string);
  await assertPermission(c, "community:react");
  await assertCommunityWritable(actorId, await isModerator(c));
  return c.json({
    data: {
      bookmarked: await toggleBookmark(
        actorId,
        postId,
      ),
    },
  });
});
/**
 * POST /comments/:commentId/like — 切换评论点赞状态。
 * 认证：必填。需 community:react 权限。
 * 响应：{ data: { liked } }。
 */
router.post("/comments/:commentId/like", authMiddleware, async (c) => {
  const actorId = userId(c);
  await assertPermission(c, "community:react");
  await assertCommunityWritable(actorId, await isModerator(c));
  return c.json({
    data: {
      liked: await toggleCommentLike(
        actorId,
        c.req.param("commentId") as string,
      ),
    },
  });
});

/**
 * POST /users/:userId/follow — 切换关注关系。
 * 认证：必填。需 community:follow 权限。:userId 可为 username 或 UUID。
 * 响应：{ data: { following } }。
 */
router.post("/users/:userId/follow", authMiddleware, async (c) => {
  const actorId = userId(c);
  await assertPermission(c, "community:follow");
  await assertCommunityWritable(actorId, await isModerator(c));
  // followeeId 可能是 username，解析为 UUID（与 profile 路由一致）
  const followeeId = await resolveUserId(c.req.param("userId") as string);
  return c.json({
    data: {
      following: await toggleFollow(actorId, followeeId),
    },
  });
});
/**
 * PUT /me/activity-visibility — 更新当前用户的活动可见性。
 * 认证：必填。body：{ visibility: "hidden" | "following" | "everyone" }。
 * 响应：{ data: 更新后的可见性 }。
 */
router.put("/me/activity-visibility", authMiddleware, async (c) => {
  const body = await parseJsonBody<
    { visibility?: "hidden" | "following" | "everyone" }
  >(c);
  if (
    !body.visibility ||
    !["hidden", "following", "everyone"].includes(body.visibility)
  ) throw new BadRequestError("无效活动可见性");
  return c.json({
    data: await updateActivityVisibility(userId(c), body.visibility),
  });
});

/**
 * GET /feed — 获取社区动态流（最新 / 关注）。
 * 认证：可选。query：view（latest/following）、cursor、limit。
 * 响应：{ data, next_cursor }。
 */
router.get("/feed", optionalAuthMiddleware, async (c) => {
  requireGuestRead(c);
  const view = c.req.query("view") === "following" ? "following" : "latest";
  return c.json(
    await listFeed(
      view,
      c.get("userId"),
      c.req.query("cursor"),
      Number(c.req.query("limit") ?? 20),
    ),
  );
});
/**
 * GET /notifications — 获取当前用户的通知列表。
 * 认证：必填。query：limit。
 * 响应：{ data: 通知列表 }。
 */
router.get(
  "/notifications",
  authMiddleware,
  async (c) =>
    c.json({
      data: await listNotifications(
        userId(c),
        Number(c.req.query("limit") ?? 30),
      ),
    }),
);
/**
 * GET /notifications/unread-count — 获取当前用户未读通知数量。
 * 认证：必填。
 * 响应：{ data: { unread_count } }。
 */
router.get(
  "/notifications/unread-count",
  authMiddleware,
  async (c) =>
    c.json({
      data: { unread_count: await getNotificationUnreadCount(userId(c)) },
    }),
);
/**
 * POST /notifications/read — 将当前用户全部未读通知标记为已读。
 * 认证：必填。响应：204。
 */
router.post("/notifications/read", authMiddleware, async (c) => {
  await markNotificationsRead(userId(c));
  return c.body(null, 204);
});
/**
 * POST /notifications/:id/read — 将单条通知标记为已读。
 * 认证：必填。仅本人通知。响应：204。
 */
router.post("/notifications/:id/read", authMiddleware, async (c) => {
  await markNotificationRead(userId(c), c.req.param("id") as string);
  return c.body(null, 204);
});

/**
 * POST /reports — 提交举报工单。
 * 认证：必填。需 community:report 权限。body：{ post_id?/comment_id?, reason, category? }。
 * 响应：201 { data: 新建举报 }。
 */
router.post("/reports", authMiddleware, async (c) => {
  const actorId = userId(c);
  await assertPermission(c, "community:report");
  // social 封禁用户不可提交举报（防止作为骚扰/滥用通道）
  await assertCommunityWritable(actorId, await isModerator(c));
  const body = await parseJsonBody<
    {
      post_id?: string;
      comment_id?: string;
      message_id?: string;
      reason?: string;
      category?: string;
    }
  >(c);
  if (!body.reason?.trim()) throw new BadRequestError("缺少举报原因");
  return c.json({
    data: await createReport(actorId, { ...body, reason: body.reason }),
  }, 201);
});
/**
 * GET /reports/:reportId — 获取举报工单详情。
 * 认证：必填。仅举报者本人或审核员可查看；非审核员不返回封禁元数据。
 * 响应：{ data: 举报详情 }。
 */
router.get("/reports/:reportId", authMiddleware, async (c) => {
  const actorId = userId(c);
  const detail = await getReportDetail(
    c.req.param("reportId") as string,
    actorId,
  );
  if (detail.report.reporter_id !== actorId && !(await isModerator(c))) {
    throw new ForbiddenError("无权查看该举报");
  }
  // 非审核员不返回被举报者的封禁元数据（避免泄露 scope/期限），仅保留处理结果摘要
  const isMod = await isModerator(c);
  if (detail.report.reporter_id === actorId && !isMod) {
    detail.ban = null;
  }
  // 查看者是举报者本人时：已撤回消息对其隐藏原文（无论是否同时是管理员）；管理员查看他人举报仍可见原文
  if (detail.report.reporter_id === actorId && detail.message?.recalled_at) {
    detail.report.content_snapshot = "该消息已撤回";
    if (detail.message) detail.message.content = "该消息已撤回";
  }
  // 举报私信消息时附带会话完整聊天记录（管理员可见全部；举报者隐藏已撤回内容）
  if (
    detail.report.content_type === "message" && detail.message?.conversation_id
  ) {
    const history = await getReportMessageHistory(
      detail.message.conversation_id,
      detail.report.reporter_id,
    );
    // 附加到响应：查看者是举报者本人时隐藏已撤回消息原文；管理员查看他人举报可见全部
    (detail as Record<string, unknown>).message_history = detail.report
        .reporter_id === actorId
      ? history.map((m) =>
        m.recalled_at ? { ...m, content: "该消息已撤回" } : m
      )
      : history;
  }
  return c.json({ data: detail });
});

export default router;
