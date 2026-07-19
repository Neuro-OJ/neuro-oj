import { Hono } from "hono";
import {
  createSubmission,
  getSubmission,
  listSubmissions,
} from "../services/submissions.ts";
import {
  getCachedTodayStats,
  getCachedTotalStats,
} from "../services/stats-cache.ts";
import { getSubmissionQueueStatus } from "../services/queue.ts";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { BadRequestError, NotFoundError } from "../lib/errors.ts";
import { buildPaginationMeta, parsePagination } from "../lib/pagination.ts";

// 扩展 Hono 类型，使 c.get("userId") 返回 string | undefined
// （optionalAuthMiddleware 注入时可能为 undefined；authMiddleware 注入时一定有值）
type Env = {
  Variables: {
    userId?: string;
    userRole?: string;
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

  // PR-6 评审修订：使用 parsePagination helper 替换 6 行样板
  const { page, perPage } = parsePagination(c, {
    defaultPerPage: 20,
    maxPerPage: 100,
  });

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

  return c.json({
    data: result.data,
    pagination: buildPaginationMeta(page, perPage, result.total),
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
 * 公开最新评测列表（无需登录）。
 * GET /api/v1/submissions/public/recent
 *
 * 返回全站最近 N 条评测的基础数据（不含 code），用于首页"最新评测"卡片等场景。
 * 限流策略：
 *   - 登录用户：两次请求至少间隔 1s（防止过快的 UI 轮询拖慢服务）
 *   - 未登录用户：两次请求至少间隔 5s（防止匿名滥用），per_page 上限 50
 * 注意：注册顺序必须在 `/:id` 之前，避免被动态段吞掉。
 */
router.get(
  "/public/recent",
  optionalAuthMiddleware,
  rateLimit({ loggedInIntervalMs: 1000, loggedOutIntervalMs: 5000 }),
  async (c) => {
    const isLoggedIn = !!c.var.userId;
    // PR-6 评审修订：使用 parsePagination，根据登录态动态调整上下限
    const { perPage } = parsePagination(c, {
      defaultPerPage: isLoggedIn ? 20 : 10,
      maxPerPage: isLoggedIn ? 100 : 50,
    });

    const result = await listSubmissions({ page: 1, perPage });
    return c.json({ data: result.data });
  },
);

/**
 * 获取今日提交统计（首页"最新评测"卡片使用）。
 * GET /api/v1/submissions/today-stats
 * 必须在 /:id 之前注册，避免被动态段吞掉。
 */
router.get(
  "/today-stats",
  optionalAuthMiddleware,
  rateLimit({ loggedInIntervalMs: 1000, loggedOutIntervalMs: 5000 }),
  async (c) => {
    // 未登录用户返回空统计，避免匿名泄露全局提交量
    if (!c.var.userId) {
      return c.json({ data: { total: 0, full_score: 0, not_full_score: 0 } });
    }
    const stats = await getCachedTodayStats(c.var.userId);
    return c.json({ data: stats });
  },
);

/**
 * 获取全站历史累计提交统计（首页"最新评测"卡片"总共"模式使用）。
 * GET /api/v1/submissions/total-stats
 * 必须在 /:id 之前注册，避免被动态段吞掉。
 */
router.get(
  "/total-stats",
  rateLimit({ loggedInIntervalMs: 1000, loggedOutIntervalMs: 5000 }),
  async (c) => {
    const stats = await getCachedTotalStats();
    return c.json({ data: stats });
  },
);

/**
 * 获取提交详情。
 *
 * 权限：基础数据公开访问；code/output/details 仅 owner 或 admin 可见。
 * 服务层 `getSubmission` 根据 viewerId/viewerRole 自动裁剪字段。
 */
router.get("/:id", optionalAuthMiddleware, async (c) => {
  const id = c.req.param("id")!;

  const result = await getSubmission(
    id,
    c.var.userId,
    c.var.userRole,
  );
  return c.json({ data: result });
});

/**
 * 获取提交的队列状态（排队位置、时间戳等）。
 * GET /api/v1/submissions/:id/status
 * 仅 admin 或提交所有者可查看；非授权用户返回 404。
 */
router.get(
  "/:id/status",
  authMiddleware,
  async (c) => {
    const id = c.req.param("id")!;
    const userId = c.var.userId!;
    const userRole = c.var.userRole!;

    const result = await getSubmissionQueueStatus(id, userId, userRole);
    if (!result) {
      throw new NotFoundError("提交不存在");
    }
    return c.json(result);
  },
);

export default router;
