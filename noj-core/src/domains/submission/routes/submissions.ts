import { type Context, Hono } from "hono";
import busboy from "busboy";
import { Readable } from "node:stream";
import {
  createArtifactSubmission,
  createSubmission,
  getSubmission,
  listSubmissions,
  resolveSubmissionId,
} from "../services/submissions/submissions.ts";
import { getCachedTodayStats, getCachedTotalStats } from "../../query/index.ts";
import { getSubmissionQueueStatus } from "../services/queue.ts";
import {
  authMiddleware,
  optionalAuthMiddleware,
} from "../../../middleware/auth.ts";
import { checkPermission } from "./../../identity/index.ts";
import { rateLimit } from "../../system/index.ts";
import {
  BadRequestError,
  NotFoundError,
} from "./../../../shared/base/errors.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import { createFileStream } from "./../../../shared/http/file-stream.ts";
import {
  buildPaginationMeta,
  parsePagination,
} from "./../../../shared/http/pagination.ts";
import { SUBMISSION_STATUSES } from "../../../types/index.ts";
import { enforceSubmissionRateLimit } from "../../system/index.ts";

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
  const userId = c.var.userId as string;

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
  const validStatuses = SUBMISSION_STATUSES;
  if (status && !(validStatuses as readonly string[]).includes(status)) {
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
 * 解析 artifact 提交的 multipart/form-data 请求。
 * 使用 busboy 流式解析，文件以 web ReadableStream 返回，避免整包读入内存。
 *
 * 一旦 `problem_id` 与文件流都就绪就立即 resolve（不等 busboy `close`），
 * 由服务层马上消费文件流，从而避免 busboy 因文件缓冲满而暂停输入导致死锁。
 */
function parseArtifactMultipart(
  c: Context,
): Promise<{
  problem_id: string;
  file_name: string;
  file_stream: ReadableStream<Uint8Array>;
  llm_provider_config_id?: string;
}> {
  return new Promise((resolve, reject) => {
    const contentType = c.req.header("content-type");
    if (!contentType) {
      reject(new BadRequestError("缺少 Content-Type"));
      return;
    }
    const bb = busboy({ headers: { "content-type": contentType } });
    let problemId = "";
    let fileName = "";
    let llmProviderConfigId = "";
    let fileStream: ReadableStream<Uint8Array> | null = null;
    let resolved = false;

    /**
     * 当 problem_id、file_name 与 file_stream 均已就绪时，立即 resolve 解析结果。
     * 幂等：已 resolve 后再次调用直接返回，避免重复触发。
     */
    function maybeResolve() {
      if (resolved) return;
      if (problemId && fileName && fileStream) {
        resolved = true;
        resolve({
          problem_id: problemId,
          file_name: fileName,
          file_stream: fileStream,
          llm_provider_config_id: llmProviderConfigId || undefined,
        });
      }
    }

    bb.on("field", (name: string, val: string) => {
      if (name === "problem_id") problemId = val;
      if (name === "llm_provider_config_id") llmProviderConfigId = val;
      maybeResolve();
    });
    bb.on("file", (name: string, file: unknown, info: { filename: string }) => {
      if (name === "file") {
        fileName = info.filename;
        fileStream = createFileStream(file as import("node:stream").Readable);
        maybeResolve();
      } else {
        (file as import("node:stream").Readable).resume();
      }
    });
    bb.on("error", (err: unknown) => {
      if (!resolved) reject(err);
    });
    bb.on("close", () => {
      if (!resolved) {
        reject(new BadRequestError("缺少必填字段：problem_id 或 file"));
      }
    });

    Readable.fromWeb(
      c.req.raw.body as unknown as import("node:stream/web").ReadableStream,
    ).pipe(bb);
  });
}

/**
 * 创建提交。
 */
router.post("/", authMiddleware, async (c) => {
  const userId = c.var.userId as string;

  // NOJ-069：提交创建 IP + 用户双维度限流。
  await enforceSubmissionRateLimit(c, userId);

  const contentType = c.req.header("content-type") ?? "";
  if (contentType.startsWith("multipart/form-data")) {
    const parsed = await parseArtifactMultipart(c);
    const result = await createArtifactSubmission(userId, parsed);
    return c.json({ data: result }, 201);
  }

  const body = await parseJsonBody<Record<string, unknown>>(c);

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
    llm_provider_config_id: body.llm_provider_config_id as string | undefined,
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

    const result = await listSubmissions({
      page: 1,
      perPage,
      excludeContest: true,
    });
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
  const id = await resolveSubmissionId(c.req.param("id") as string);

  const result = await getSubmission(
    id,
    c.var.userId,
    undefined,
    c,
  );
  return c.json({ data: result });
});

/**
 * 获取提交的队列状态（排队位置、时间戳等）。
 * GET /api/v1/submissions/:id/status
 * 任意已登录用户均可查看，不限制提交所有者身份。
 */
router.get(
  "/:id/status",
  authMiddleware,
  async (c) => {
    const id = await resolveSubmissionId(c.req.param("id") as string);
    const userId = c.var.userId as string;
    // NOJ-049：仅提交所有者或实时 RBAC 的 submission:read_all 可查看队列状态。
    const isAdmin = await checkPermission(c, "submission:read_all");
    const result = await getSubmissionQueueStatus(
      id,
      userId,
      isAdmin ? "admin" : undefined,
    );
    if (!result) {
      throw new NotFoundError("提交不存在");
    }
    return c.json(result);
  },
);

export default router;
