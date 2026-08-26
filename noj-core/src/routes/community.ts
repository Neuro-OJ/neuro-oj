import { Hono } from "hono";
import { parseJsonBody } from "../lib/request.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../lib/errors.ts";
import { assertPermission, checkPermission } from "../lib/permissions.ts";
import {
  authMiddleware,
  type OptionalAuthEnv,
  optionalAuthMiddleware,
} from "../middleware/auth.ts";
import type {
  CommunityPostInput,
  CommunityPostType,
} from "../types/community.ts";
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

function userId(c: { get: (key: "userId") => string | undefined }): string {
  const id = c.get("userId");
  if (!id) throw new ForbiddenError("请先登录");
  return id;
}

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

async function requirePostPermission(
  c: Parameters<typeof assertPermission>[0],
  type: CommunityPostType,
): Promise<void> {
  await assertPermission(c, `community:create_${type}`);
}

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

router.get("/boards", optionalAuthMiddleware, async (c) => {
  assertCommunityEnabled("discussions_enabled");
  requireGuestRead(c);
  return c.json({ data: await listBoards() });
});

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

router.get("/bookmarks", authMiddleware, async (c) => {
  return c.json(
    await listBookmarks(
      userId(c),
      c.req.query("cursor"),
      Number(c.req.query("limit") ?? 20),
    ),
  );
});

router.get("/posts/counts", optionalAuthMiddleware, async (c) => {
  assertCommunityEnabled();
  requireGuestRead(c);
  return c.json({ data: await countPostsByType() });
});

/**
 * 题解发布资格：题目页发布入口据此展示启用/禁用态与原因。
 * 返回题解模块开关、门槛是否开启、当前用户是否已 Accepted 以及能否发布。
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
  await assertCommunityWritable(actorId, await isModerator(c));
  return c.json({
    data: await changePostStatus(
      postId,
      actorId,
      "deleted",
    ),
  });
});

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
    ),
  }, 201);
});

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
router.delete("/comments/:commentId", authMiddleware, async (c) => {
  const actorId = userId(c);
  await assertCommunityWritable(actorId, await isModerator(c));
  return c.json({
    data: await deleteComment(
      c.req.param("commentId") as string,
      actorId,
      await isModerator(c),
    ),
  });
});

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

router.post("/users/:userId/follow", authMiddleware, async (c) => {
  const actorId = userId(c);
  await assertPermission(c, "community:follow");
  await assertCommunityWritable(actorId, await isModerator(c));
  return c.json({
    data: {
      following: await toggleFollow(actorId, c.req.param("userId") as string),
    },
  });
});
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
router.get(
  "/notifications/unread-count",
  authMiddleware,
  async (c) =>
    c.json({
      data: { unread_count: await getNotificationUnreadCount(userId(c)) },
    }),
);
router.post("/notifications/read", authMiddleware, async (c) => {
  await markNotificationsRead(userId(c));
  return c.body(null, 204);
});
router.post("/notifications/:id/read", authMiddleware, async (c) => {
  await markNotificationRead(userId(c), c.req.param("id") as string);
  return c.body(null, 204);
});

router.post("/reports", authMiddleware, async (c) => {
  const actorId = userId(c);
  await assertPermission(c, "community:report");
  // social 封禁用户不可提交举报（防止作为骚扰/滥用通道）
  await assertCommunityWritable(actorId, await isModerator(c));
  const body = await parseJsonBody<
    { post_id?: string; comment_id?: string; reason?: string; category?: string }
  >(c);
  if (!body.reason?.trim()) throw new BadRequestError("缺少举报原因");
  return c.json({
    data: await createReport(actorId, { ...body, reason: body.reason }),
  }, 201);
});
// 举报工单详情（举报者本人可查，供用户可见的举报工单页）
router.get("/reports/:reportId", authMiddleware, async (c) => {
  const actorId = userId(c);
  const detail = await getReportDetail(c.req.param("reportId") as string, actorId);
  if (detail.report.reporter_id !== actorId && !(await isModerator(c))) {
    throw new ForbiddenError("无权查看该举报");
  }
  // 非审核员不返回被举报者的封禁元数据（避免泄露 scope/期限），仅保留处理结果摘要
  if (detail.report.reporter_id === actorId && !(await isModerator(c))) {
    detail.ban = null;
  }
  return c.json({ data: detail });
});

export default router;
