import { Hono } from "hono";
import {
  createSubmission,
  getSubmission,
  listSubmissions,
} from "../services/submissions.ts";
import { getSubmissionQueueStatus } from "../services/queue.ts";
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
 * 提交代码最大长度（字符数）。
 *
 * 限制原因：
 * 1. Redis 单值上限 512MB，超大消息会导致 LPUSH 失败或集群分裂
 * 2. 评测 worker 在 Docker 容器内加载代码，过大文件增加 IO 与内存开销
 * 3. 防止恶意用户通过超大提交耗尽存储与带宽
 *
 * 100KB 足以覆盖绝大多数 ACM/OI 题目的解题代码；如有特殊需求可走管理员通道。
 */
const MAX_CODE_LENGTH = 100 * 1024;

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
  const problemSearch = c.req.query("problem_search") || undefined;
  const submissionId = c.req.query("submission_id") || undefined;
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

  // 大小限制：防止恶意大请求耗尽存储与 Redis 单值上限（512MB）
  // 100KB 足以覆盖绝大多数代码提交；超过则提示客户端精简代码或拆分提交
  if (typeof body.code !== "string") {
    throw new BadRequestError("code 字段必须为字符串");
  }
  if (body.code.length > MAX_CODE_LENGTH) {
    throw new BadRequestError(
      `代码长度超过限制（${MAX_CODE_LENGTH} 字符），请精简后重新提交`,
    );
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
 * 获取提交的队列状态（排队位置、时间戳等）。
 * GET /api/v1/submissions/:id/status
 * 仅 admin 或提交所有者可查看；非授权用户返回 404。
 */
router.get("/:id/status", authMiddleware, async (c) => {
  const id = c.req.param("id")!;
  const userId = c.var.userId!;
  const userRole = c.var.userRole!;

  const result = await getSubmissionQueueStatus(id, userId, userRole);
  if (!result) {
    return c.json({ error: "提交不存在" }, 404);
  }
  return c.json(result);
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

  // 解析筛选参数（额外支持 user_id、user_search）
  const userId = c.req.query("user_id") || undefined;
  const userSearch = c.req.query("user_search") || undefined;
  const problemId = c.req.query("problem_id") || undefined;
  const problemSearch = c.req.query("problem_search") || undefined;
  const submissionId = c.req.query("submission_id") || undefined;
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

export { adminSubmissions };
export default router;
