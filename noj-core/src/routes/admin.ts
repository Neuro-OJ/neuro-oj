import { Hono } from "hono";
import { adminMiddleware, authMiddleware } from "../middleware/auth.ts";
import { parseJsonBody } from "../lib/request.ts";
import {
  BadRequestError,
  ValidationError,
} from "../lib/errors.ts";
import { listUsers, promoteUser } from "../services/auth.ts";
import { getDashboardStats } from "../services/dashboard.ts";
import { listAllProblems } from "../services/problems.ts";
import {
  createJudgeImage,
  deleteJudgeImage,
  listJudgeImages,
  updateJudgeImage,
} from "../services/judge-images.ts";
import type {
  CreateJudgeImageInput,
  UpdateJudgeImageInput,
} from "../types/problems.ts";
import {
  deleteSubmission,
  getSubmission,
  listSubmissions,
  rejudgeProblemSubmissions,
  rejudgeSubmission,
} from "../services/submissions.ts";
import {
  adminUpdateUserProfile,
  banUser,
  getUserBanHistory,
  unbanUser,
} from "../services/users.ts";
import { addIpBan, listIpBans, removeIpBan } from "../services/banlist.ts";
import {
  listSettings,
  resetSetting,
  updateSetting,
} from "../services/system-settings.ts";
import { listAuditLogs } from "../services/audit-log.ts";
import type { AuditAction } from "../types/audit-log.ts";

const router = new Hono<{ Variables: { userId: string; userRole: string } }>();

// 路由组级中间件：所有 admin 端点均需认证 + 管理员权限
router.use("*", authMiddleware, adminMiddleware);

// ─── 用户管理 ───────────────────────────────────────────────

/**
 * 管理员获取用户列表（分页 + 搜索筛选）。
 * GET /api/v1/admin/users
 */
router.get("/users", async (c) => {
  let page = parseInt(c.req.query("page") ?? "1", 10);
  let perPage = parseInt(c.req.query("per_page") ?? "20", 10);
  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(perPage) || perPage < 1) perPage = 20;
  if (perPage > 100) perPage = 100;

  const keyword = c.req.query("keyword") || undefined;
  const role = c.req.query("role") || undefined;
  const from = c.req.query("from") || undefined;
  const to = c.req.query("to") || undefined;

  const result = await listUsers({ page, perPage, keyword, role, from, to });
  return c.json({ data: result.data, pagination: result.pagination });
});

/**
 * 管理员提升/降级用户角色。
 * PATCH /api/v1/admin/users/:id/role
 */
router.patch("/users/:id/role", async (c) => {
  const targetUserId = c.req.param("id") as string;
  const body = await parseJsonBody<{ role: string }>(c);

  if (!body.role) {
    throw new ValidationError("缺少必填字段：role");
  }

  const user = await promoteUser(targetUserId, body.role, c.get("userId"));
  return c.json({ data: user }, 200);
});

/**
 * 管理员编辑用户资料。
 * PUT /api/v1/admin/users/:id
 */
router.put("/users/:id", async (c) => {
  const targetUserId = c.req.param("id") as string;
  const body = await parseJsonBody<{ email?: string; bio?: string }>(c);

  if (body.email === undefined && body.bio === undefined) {
    throw new BadRequestError("至少需要提供一个可更新字段（email 或 bio）");
  }

  const user = await adminUpdateUserProfile(targetUserId, body);
  return c.json({ data: user }, 200);
});

// ─── 题目管理 ───────────────────────────────────────────────

/**
 * 管理员获取全量题目列表（含 U 型和 P 型）。
 * GET /api/v1/admin/problems
 */
router.get("/problems", async (c) => {
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);

  if (Number.isNaN(page) || Number.isNaN(limit)) {
    throw new BadRequestError("分页参数 page 和 limit 必须为数字");
  }

  const result = await listAllProblems({
    page: Math.max(1, page),
    limit: Math.min(100, Math.max(1, limit)),
    difficulty: c.req.query("difficulty") || undefined,
    category_id: c.req.query("category_id") || undefined,
    keyword: c.req.query("keyword") || undefined,
  });

  return c.json({
    data: result.items,
    total: result.total,
    page: result.page,
    limit: result.limit,
  });
});

// ─── 提交管理 ───────────────────────────────────────────────

/**
 * 管理员获取全部提交列表（分页 + 筛选）。
 * GET /api/v1/admin/submissions
 */
router.get("/submissions", async (c) => {
  let page = parseInt(c.req.query("page") ?? "", 10);
  let perPage = parseInt(c.req.query("per_page") ?? "", 10);

  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(perPage) || perPage < 1) perPage = 20;
  if (perPage > 100) perPage = 100;

  const userId = c.req.query("user_id") || undefined;
  const userSearch = c.req.query("user_search") || undefined;
  const problemId = c.req.query("problem_id") || undefined;
  const problemSearch = c.req.query("problem_search") || undefined;
  const submissionId = c.req.query("submission_id") || undefined;
  const language = c.req.query("language") || undefined;
  const status = c.req.query("status") || undefined;
  const from = c.req.query("from") || undefined;
  const to = c.req.query("to") || undefined;

  const validStatuses = ["pending", "judging", "finished", "error"];
  if (status && !validStatuses.includes(status)) {
    throw new BadRequestError(
      `无效的状态值：${status}，有效值：${validStatuses.join("、")}`,
    );
  }

  const result = await listSubmissions({
    userId,
    userSearch,
    problemId,
    problemSearch,
    submissionId,
    language,
    status,
    from,
    to,
    page,
    perPage,
  });

  const totalPages = Math.ceil(result.total / perPage);

  return c.json({
    data: result.data,
    pagination: {
      page,
      per_page: perPage,
      total: result.total,
      total_pages: totalPages,
    },
  });
});

/**
 * 管理员查看任意提交详情（含 code）。
 * GET /api/v1/admin/submissions/:id
 */
router.get("/submissions/:id", async (c) => {
  const id = c.req.param("id") as string;
  // 传入 userId/userRole 确保管理员能看到 code/output/details
  const result = await getSubmission(id, c.get("userId"), c.get("userRole"));
  return c.json({ data: result });
});

/**
 * 管理员删除提交记录。
 * DELETE /api/v1/admin/submissions/:id
 */
router.delete("/submissions/:id", async (c) => {
  const id = c.req.param("id") as string;
  await deleteSubmission(id);
  return c.body(null, 204);
});

/**
 * 管理员重测提交。
 * POST /api/v1/admin/submissions/:id/rejudge
 */
router.post("/submissions/:id/rejudge", async (c) => {
  const id = c.req.param("id") as string;
  await rejudgeSubmission(id);
  return c.json({ message: "重测任务已提交", submission_id: id });
});

/**
 * 管理员批量重测题目的所有已完结提交。
 * POST /api/v1/admin/problems/:id/rejudge
 */
router.post("/problems/:id/rejudge", async (c) => {
  const id = c.req.param("id") as string;
  const result = await rejudgeProblemSubmissions(id);
  return c.json({
    message: "批量重测任务已提交",
    problem_id: id,
    ...result,
  });
});

// ─── 评测镜像白名单管理 ───────────────────────────────────────

/**
 * 获取所有白名单条目。
 * GET /api/v1/admin/judge-images
 */
router.get("/judge-images", async (c) => {
  const items = await listJudgeImages();
  return c.json({ data: items });
});

/**
 * 新增白名单条目。
 * POST /api/v1/admin/judge-images
 */
router.post("/judge-images", async (c) => {
  const body = await parseJsonBody<CreateJudgeImageInput>(c);

  if (!body.image?.trim()) {
    throw new BadRequestError("镜像名不能为空");
  }

  const item = await createJudgeImage(body);
  return c.json({ data: item }, 201);
});

/**
 * 更新白名单条目。
 * PUT /api/v1/admin/judge-images/:id
 */
router.put("/judge-images/:id", async (c) => {
  const id = c.req.param("id") as string;
  const body = await parseJsonBody<UpdateJudgeImageInput>(c);
  const item = await updateJudgeImage(id, body);
  return c.json({ data: item }, 200);
});

/**
 * 删除白名单条目。
 * DELETE /api/v1/admin/judge-images/:id
 */
router.delete("/judge-images/:id", async (c) => {
  const id = c.req.param("id") as string;
  await deleteJudgeImage(id);
  return c.body(null, 204);
});

// ─── 仪表盘 ─────────────────────────────────────────────────

/**
 * 仪表盘统计数据。
 * GET /api/v1/admin/dashboard/stats
 */
router.get("/dashboard/stats", async (c) => {
  const stats = await getDashboardStats();
  return c.json({ data: stats });
});

// ─── 系统设置（issue #99）───────────────────────────────────

/**
 * 列出所有系统设置项（DB-backed 5 项 + env-only N 项）。
 * GET /api/v1/admin/settings
 *
 * 注意：必须先注册静态路径 `/settings`，再注册参数化路径 `/settings/:key`，
 * 否则 `GET /settings` 会被 `/settings/:key` 误匹配。
 */
router.get("/settings", async (c) => {
  const items = await listSettings();
  return c.json({ data: items });
});

/**
 * 更新单个设置项（UPSERT）。
 * PUT /api/v1/admin/settings/:key
 * body: { value: boolean | string }
 */
router.put("/settings/:key", async (c) => {
  const key = c.req.param("key") as string;
  const body = await parseJsonBody<{ value: unknown }>(c);
  if (!("value" in body)) {
    throw new BadRequestError("请求体必须包含 value 字段");
  }
  const item = await updateSetting(key, body.value, c.get("userId"));
  return c.json({ data: item }, 200);
});

/**
 * 重置单个设置项（DELETE FROM system_settings，回退到 env/default）。
 * DELETE /api/v1/admin/settings/:key
 * 幂等：DB 不存在也正常返回 204。
 */
router.delete("/settings/:key", async (c) => {
  const key = c.req.param("key") as string;
  await resetSetting(key, c.get("userId"));
  return c.body(null, 204);
});

// ─── IP 黑名单管理（issue #102）────────────────────────────────

/**
 * 管理员列出 IP 黑名单（分页 + 模糊搜索）。
 * GET /api/v1/admin/blacklist?page=&per_page=&keyword=
 */
router.get("/blacklist", async (c) => {
  let page = parseInt(c.req.query("page") ?? "1", 10);
  let perPage = parseInt(c.req.query("per_page") ?? "20", 10);
  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(perPage) || perPage < 1) perPage = 20;
  if (perPage > 100) perPage = 100;

  const keyword = c.req.query("keyword") || undefined;
  const result = await listIpBans({ page, perPage, keyword });
  return c.json({ data: result.data, pagination: result.pagination });
});

/**
 * 管理员添加 IP 黑名单。
 * POST /api/v1/admin/blacklist
 * body: { ip_or_cidr, reason?, expires_at? }
 */
router.post("/blacklist", async (c) => {
  const body = await parseJsonBody<{
    ip_or_cidr: string;
    reason?: string;
    expires_at?: string | null;
  }>(c);
  if (!body.ip_or_cidr) {
    throw new ValidationError("缺少必填字段：ip_or_cidr");
  }
  const ban = await addIpBan(body, c.get("userId"));
  return c.json({ data: ban }, 201);
});

/**
 * 管理员删除 IP 黑名单条目。
 * DELETE /api/v1/admin/blacklist/:id
 */
router.delete("/blacklist/:id", async (c) => {
  const id = c.req.param("id") as string;
  await removeIpBan(id, c.get("userId"));
  return c.body(null, 204);
});

// ─── 用户封禁管理（issue #102）────────────────────────────────

/**
 * 管理员封禁用户。
 * PATCH /api/v1/admin/users/:id/ban
 * body: { reason?, banned_until? }
 */
router.patch("/users/:id/ban", async (c) => {
  const targetUserId = c.req.param("id") as string;
  const body = await parseJsonBody<{
    reason?: string;
    banned_until?: string | null;
  }>(c);
  const user = await banUser(
    targetUserId,
    body.reason,
    body.banned_until,
    c.get("userId"),
  );
  return c.json({ data: user }, 200);
});

/**
 * 管理员解封用户。
 * PATCH /api/v1/admin/users/:id/unban
 */
router.patch("/users/:id/unban", async (c) => {
  const targetUserId = c.req.param("id") as string;
  const user = await unbanUser(targetUserId, c.get("userId"));
  return c.json({ data: user }, 200);
});

/**
 * 获取用户封禁历史（user-ban-table）。
 * GET /api/v1/admin/users/:id/bans
 */
router.get("/users/:id/bans", async (c) => {
  const targetUserId = c.req.param("id") as string;
  const records = await getUserBanHistory(targetUserId);
  return c.json({ data: records }, 200);
});

// ─── 审计日志（issue #101）───────────────────────────────────

/**
 * 管理员查询审计日志（分页 + 筛选）。
 * GET /api/v1/admin/audit-logs
 *
 * Query:
 *   page, per_page (default 20, max 100)
 *   admin_id?, action?, from?, to?  (ISO 8601)
 */
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
export default router;
