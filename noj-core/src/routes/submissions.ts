import { Hono } from "hono";
import {
  createSubmission,
  getSubmission,
  listSubmissions,
} from "../services/submissions.ts";
import { adminMiddleware, authMiddleware } from "../middleware/auth.ts";
import { BadRequestError } from "../lib/errors.ts";

// 扩展 Hono 类型，使 c.get("userId") 返回 string
type Env = {
  Variables: {
    userId: string;
    userRole: string;
  };
};

const router = new Hono<Env>();

/**
 * 提交列表（分页 + 筛选）。
 * GET /api/v1/submissions
 * 返回当前认证用户的提交记录，支持按 problem_id、language、status、日期范围筛选。
 */
router.get("/", authMiddleware, async (c) => {
  const userId = c.var.userId!;

  // 解析分页参数
  let page = parseInt(c.req.query("page") ?? "", 10);
  let perPage = parseInt(c.req.query("per_page") ?? "", 10);

  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(perPage) || perPage < 1) perPage = 20;
  if (perPage > 100) perPage = 100;

  // 解析筛选参数
  const problemId = c.req.query("problem_id") || undefined;
  const language = c.req.query("language") || undefined;
  const status = c.req.query("status") || undefined;
  const from = c.req.query("from") || undefined;
  const to = c.req.query("to") || undefined;

  // status 参数校验
  const validStatuses = ["pending", "judging", "finished", "error"];
  if (status && !validStatuses.includes(status)) {
    throw new BadRequestError(
      `无效的状态值：${status}，有效值：${validStatuses.join("、")}`,
    );
  }

  const result = await listSubmissions({
    userId,
    problemId,
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
 * 创建提交。
 */
router.post("/", authMiddleware, async (c) => {
  const userId = c.var.userId!;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    throw new BadRequestError("请求体格式错误：需要有效的 JSON");
  }

  // 必填字段验证
  if (!body.problem_id || !body.language || !body.code) {
    const missing: string[] = [];
    if (!body.problem_id) missing.push("problem_id");
    if (!body.language) missing.push("language");
    if (!body.code) missing.push("code");
    throw new BadRequestError(`缺少必填字段: ${missing.join(", ")}`);
  }

  const result = await createSubmission(userId, {
    problem_id: body.problem_id as string,
    language: body.language as string,
    code: body.code as string,
    file_name: body.file_name as string | undefined,
  });

  return c.json({ data: result }, 201);
});

/**
 * 获取提交详情。
 */
router.get("/:id", authMiddleware, async (c) => {
  const id = c.req.param("id")!;

  const result = await getSubmission(id, c.var.userId);
  return c.json({ data: result });
});

/**
 * 管理员提交列表路由。
 * 需要 authMiddleware + adminMiddleware 双重保护。
 */
const adminSubmissions = new Hono<
  { Variables: { userId: string; userRole: string } }
>();

adminSubmissions.get("/", authMiddleware, adminMiddleware, async (c) => {
  // 解析分页参数
  let page = parseInt(c.req.query("page") ?? "", 10);
  let perPage = parseInt(c.req.query("per_page") ?? "", 10);

  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(perPage) || perPage < 1) perPage = 20;
  if (perPage > 100) perPage = 100;

  // 解析筛选参数（额外支持 user_id）
  const userId = c.req.query("user_id") || undefined;
  const problemId = c.req.query("problem_id") || undefined;
  const language = c.req.query("language") || undefined;
  const status = c.req.query("status") || undefined;
  const from = c.req.query("from") || undefined;
  const to = c.req.query("to") || undefined;

  // status 参数校验
  const validStatuses = ["pending", "judging", "finished", "error"];
  if (status && !validStatuses.includes(status)) {
    throw new BadRequestError(
      `无效的状态值：${status}，有效值：${validStatuses.join("、")}`,
    );
  }

  const result = await listSubmissions({
    userId,
    problemId,
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

export { adminSubmissions };
export default router;
