import { Hono } from "hono";
import type { Next } from "hono";
import { parseJsonBody } from "../lib/request.ts";
import { BadRequestError, ForbiddenError } from "../lib/errors.ts";
import { assertPermission, checkPermission } from "../lib/permissions.ts";
import { COMMUNITY_PRESETS, MODERATION_STATUSES } from "../types/community.ts";
import { authMiddleware } from "../middleware/auth.ts";
import type { OptionalAuthEnv } from "../middleware/auth.ts";
import {
  applyCommunityPreset,
  changeCommentStatus,
  changePostStatus,
  createBoard,
  createSanction,
  deleteBoardRoleGrant,
  listBoardRoleGrants,
  listPendingComments,
  listReports,
  listSanctions,
  listUserSanctions,
  resolveReport,
  revokeSanction,
  togglePostFlag,
  updateBoard,
  updateBoardRoleGrant,
} from "../services/community/community.ts";

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

router.use("/admin/*", authMiddleware, requireCommunityModeration);

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
  if (!(MODERATION_STATUSES as readonly string[]).includes(status)) {
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
    c.json({ data: await listUserSanctions(c.req.param("userId") as string) }),
);

export default router;
