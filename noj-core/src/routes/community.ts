import { Hono } from "hono";
import type { Next } from "hono";
import { streamSSE } from "hono/streaming";
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
import { Channels, onEvent } from "../lib/event-bus.ts";
import type {
  CommunityPostInput,
  CommunityPostType,
} from "../types/community.ts";
import {
  applyCommunityPreset,
  assertCommunityEnabled,
  assertCommunityWritable,
  changeCommentStatus,
  changePostStatus,
  countPostsByType,
  createBoard,
  createComment,
  createPost,
  createReport,
  createSanction,
  deleteBoardRoleGrant,
  deleteComment,
  getCommunityConfig,
  getNotificationUnreadCount,
  getPost,
  hasAcceptedSolution,
  listBoardRoleGrants,
  listBoards,
  listBookmarks,
  listComments,
  listFeed,
  listNotifications,
  listPendingComments,
  listPosts,
  listReports,
  listSanctions,
  listUserSanctions,
  markNotificationRead,
  markNotificationsRead,
  resolveProblemId,
  resolveReport,
  revokeSanction,
  toggleBookmark,
  toggleCommentLike,
  toggleFollow,
  togglePostFlag,
  togglePostLike,
  updateActivityVisibility,
  updateBoard,
  updateBoardRoleGrant,
  updateComment,
  updatePost,
} from "../services/community.ts";

const router = new Hono<OptionalAuthEnv>();

function userId(c: { get: (key: "userId") => string | undefined }): string {
  const id = c.get("userId");
  if (!id) throw new ForbiddenError("请先登录");
  return id;
}

async function isModerator(
  c: Parameters<typeof checkPermission>[0],
): Promise<boolean> {
  return c.var.isAdmin === true ||
    await checkPermission(c, "community_moderation:review");
}

async function requirePostPermission(
  c: Parameters<typeof assertPermission>[0],
  type: CommunityPostType,
): Promise<void> {
  await assertPermission(c, `community:create_${type}`);
}

/**
 * 社区管理路由守卫：管理员（is_admin fast path）或具备
 * `community_moderation:review` 权限的审核员可进入；
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
  if (!getCommunityConfig().guest_read_enabled && !c.get("userId")) {
    throw new UnauthorizedError("登录后可查看社区");
  }
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
  if (!getCommunityConfig().guest_read_enabled && !c.get("userId")) {
    throw new UnauthorizedError("登录后可查看社区");
  }
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
  if (!getCommunityConfig().guest_read_enabled && !c.get("userId")) {
    throw new UnauthorizedError("登录后可查看社区");
  }
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
  if (!getCommunityConfig().guest_read_enabled && !c.get("userId")) {
    throw new UnauthorizedError("登录后可查看社区");
  }
  return c.json({
    data: await getPost(
      c.req.param("postId")!,
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
  await assertCommunityWritable(actorId, await isModerator(c));
  const input = await parseJsonBody<
    Partial<Pick<CommunityPostInput, "title" | "content">>
  >(c);
  return c.json({
    data: await updatePost(
      c.req.param("postId")!,
      actorId,
      await isModerator(c),
      input,
    ),
  });
});

router.delete("/posts/:postId", authMiddleware, async (c) => {
  const actorId = userId(c);
  const post = await getPost(
    c.req.param("postId")!,
    actorId,
    await isModerator(c),
  );
  if (post.post.author_id !== actorId && !(await isModerator(c))) {
    throw new ForbiddenError("无权删除该内容");
  }
  await assertCommunityWritable(actorId, await isModerator(c));
  return c.json({
    data: await changePostStatus(c.req.param("postId")!, actorId, "deleted"),
  });
});

router.get(
  "/posts/:postId/comments",
  optionalAuthMiddleware,
  async (c) => {
    if (!getCommunityConfig().guest_read_enabled && !c.get("userId")) {
      throw new UnauthorizedError("登录后可查看社区");
    }
    return c.json({
      data: await listComments(
        c.req.param("postId")!,
        c.get("userId"),
        c.get("userId") ? await isModerator(c) : false,
      ),
    });
  },
);
router.post("/posts/:postId/comments", authMiddleware, async (c) => {
  const actorId = userId(c);
  await assertPermission(c, "community:comment");
  await assertCommunityWritable(actorId, await isModerator(c));
  const body = await parseJsonBody<{ content?: string; parent_id?: string }>(c);
  if (!body.content) throw new BadRequestError("缺少评论内容");
  return c.json({
    data: await createComment(
      actorId,
      c.req.param("postId")!,
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
      c.req.param("commentId")!,
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
      c.req.param("commentId")!,
      actorId,
      await isModerator(c),
    ),
  });
});

router.post("/posts/:postId/like", authMiddleware, async (c) => {
  const actorId = userId(c);
  await assertPermission(c, "community:react");
  await assertCommunityWritable(actorId, await isModerator(c));
  return c.json({
    data: { liked: await togglePostLike(actorId, c.req.param("postId")!) },
  });
});
router.post("/posts/:postId/bookmark", authMiddleware, async (c) => {
  const actorId = userId(c);
  await assertPermission(c, "community:react");
  await assertCommunityWritable(actorId, await isModerator(c));
  return c.json({
    data: { bookmarked: await toggleBookmark(actorId, c.req.param("postId")!) },
  });
});
router.post("/comments/:commentId/like", authMiddleware, async (c) => {
  const actorId = userId(c);
  await assertPermission(c, "community:react");
  await assertCommunityWritable(actorId, await isModerator(c));
  return c.json({
    data: {
      liked: await toggleCommentLike(actorId, c.req.param("commentId")!),
    },
  });
});

router.post("/users/:userId/follow", authMiddleware, async (c) => {
  const actorId = userId(c);
  await assertPermission(c, "community:follow");
  await assertCommunityWritable(actorId, await isModerator(c));
  return c.json({
    data: { following: await toggleFollow(actorId, c.req.param("userId")!) },
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
  if (!getCommunityConfig().guest_read_enabled && !c.get("userId")) {
    throw new UnauthorizedError("登录后可查看社区");
  }
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
/**
 * GET /api/v1/community/notifications/events
 * 社区通知 SSE 端点。
 *
 * 收到 notification:new 事件后前端应刷新通知列表和未读计数。
 * SSE 事件仅作触发器，不包含通知内容。
 */
router.get("/notifications/events", authMiddleware, (c) => {
  const userId = c.get("userId") as string;
  return streamSSE(c, async (stream) => {
    let streamClosed = false;

    function closeStream() {
      if (streamClosed) return;
      streamClosed = true;
      clearInterval(keepAlive);
      unsub();
    }

    const unsub = onEvent(
      Channels.user(userId),
      (_channel, message) => {
        if (streamClosed) return;
        // 仅透传社区通知事件，避免与私信等同一用户通道事件交叉
        try {
          const payload = JSON.parse(message) as { type?: string };
          if (payload.type !== "notification:new") return;
        } catch {
          return;
        }
        stream.writeSSE({
          event: "notification:new",
          data: message,
        }).catch(() => {
          closeStream();
        });
      },
    );

    // 30s 心跳保持连接
    const keepAlive = setInterval(() => {
      if (streamClosed) return;
      stream.writeSSE({ event: "keepalive", data: "" }).catch(() => {
        closeStream();
      });
    }, 30_000);

    // 发送初始化事件，触发代理 flush 响应头
    await stream.writeSSE({ event: "connected", data: "" });
    stream.onAbort(() => closeStream());
  });
});
router.post("/notifications/:id/read", authMiddleware, async (c) => {
  await markNotificationRead(userId(c), c.req.param("id")!);
  return c.body(null, 204);
});

router.post("/reports", authMiddleware, async (c) => {
  const actorId = userId(c);
  await assertPermission(c, "community:report");
  const body = await parseJsonBody<
    { post_id?: string; comment_id?: string; reason?: string }
  >(c);
  if (!body.reason?.trim()) throw new BadRequestError("缺少举报原因");
  return c.json({
    data: await createReport(actorId, { ...body, reason: body.reason }),
  }, 201);
});

router.use("/admin/*", authMiddleware, requireCommunityModeration);
router.post("/admin/preset/:preset", async (c) => {
  // 预设属于系统配置，仅管理员可应用
  await assertPermission(c, "system:settings");
  const preset = c.req.param("preset");
  if (!(["public", "private", "knowledge"] as string[]).includes(preset)) {
    throw new BadRequestError("无效社区预设");
  }
  return c.json({
    data: await applyCommunityPreset(
      userId(c),
      preset as "public" | "private" | "knowledge",
    ),
  });
});
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
router.get(
  "/admin/boards/:boardId/role-grants",
  async (c) => {
    await assertPermission(c, "community_board:manage");
    return c.json({ data: await listBoardRoleGrants(c.req.param("boardId")) });
  },
);
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
router.delete("/admin/boards/:boardId/role-grants/:roleId", async (c) => {
  await assertPermission(c, "community_board:manage");
  await deleteBoardRoleGrant(c.req.param("boardId"), c.req.param("roleId"));
  return c.body(null, 204);
});
router.get(
  "/admin/reports",
  async (c) => c.json({ data: await listReports() }),
);
router.get(
  "/admin/comments/pending",
  async (c) =>
    c.json({
      data: await listPendingComments(Number(c.req.query("limit") ?? 50)),
    }),
);
router.post("/admin/reports/:reportId/:status", async (c) => {
  const status = c.req.param("status");
  if (status !== "resolved" && status !== "dismissed") {
    throw new BadRequestError("无效举报状态");
  }
  const body = await parseJsonBody<{ resolution?: string }>(c);
  return c.json({
    data: await resolveReport(
      c.req.param("reportId"),
      userId(c),
      status,
      body.resolution,
    ),
  });
});
router.post("/admin/posts/:postId/:status", async (c) => {
  const status = c.req.param("status");
  if (!(["published", "hidden", "deleted"] as string[]).includes(status)) {
    throw new BadRequestError("无效内容状态");
  }
  const body = await parseJsonBody<{ reason?: string }>(c);
  return c.json({
    data: await changePostStatus(
      c.req.param("postId"),
      userId(c),
      status as "published" | "hidden" | "deleted",
      body.reason,
    ),
  });
});
router.post("/admin/comments/:commentId/:status", async (c) => {
  const status = c.req.param("status");
  if (!(["published", "hidden", "deleted"] as string[]).includes(status)) {
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
router.post("/admin/posts/:postId/:flag", async (c) => {
  // 锁定/置顶：community_moderation:lock
  await assertPermission(c, "community_moderation:lock");
  const flag = c.req.param("flag");
  if (flag !== "lock" && flag !== "pin") {
    throw new BadRequestError("无效内容操作");
  }
  const body = await parseJsonBody<{ value?: boolean }>(c);
  return c.json({
    data: await togglePostFlag(
      c.req.param("postId"),
      userId(c),
      flag === "lock" ? "is_locked" : "is_pinned",
      body.value === true,
    ),
  });
});
router.get(
  "/admin/sanctions",
  async (c) => c.json({ data: await listSanctions() }),
);
router.post("/admin/sanctions", async (c) => {
  // 社区处罚：community_moderation:sanction
  await assertPermission(c, "community_moderation:sanction");
  const body = await parseJsonBody<
    { user_id?: string; reason?: string; expires_at?: string }
  >(c);
  if (!body.user_id || !body.reason) {
    throw new BadRequestError("缺少用户或处罚原因");
  }
  return c.json({
    data: await createSanction(
      userId(c),
      body.user_id,
      body.reason,
      body.expires_at,
    ),
  }, 201);
});
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
router.get(
  "/admin/users/:userId/sanctions",
  async (c) =>
    c.json({ data: await listUserSanctions(c.req.param("userId")!) }),
);

export default router;
