import { Hono } from "hono";
import type { AuthEnv } from "./../../identity/index.ts";
import { BadRequestError } from "./../../../shared/base/errors.ts";
import {
  deleteSubmission,
  getSubmission,
  listSubmissions,
  rejudgeProblemSubmissions,
  rejudgeSubmission,
  resolveSubmissionId,
} from "../services/submissions/submissions.ts";
import { getQueueHealth, removePendingSubmission } from "../services/queue.ts";
import { resolveProblem } from "./../../catalog/index.ts";
import { SUBMISSION_STATUSES } from "../types/index.ts";

/**
 * 管理端提交管理路由（挂载前缀 /api/v1/admin，见 admin/index.ts）。
 *
 * 提供：
 * - GET    /submissions              全部提交列表（分页 + 筛选）
 * - GET    /submissions/:id          提交详情（含 code）
 * - DELETE /submissions/:id          删除提交
 * - POST   /submissions/:id/rejudge  重测单个提交
 * - POST   /problems/:id/rejudge     批量重测题目的已完结提交
 */
const router = new Hono<AuthEnv>();

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

  const validStatuses = SUBMISSION_STATUSES;
  if (status && !(validStatuses as readonly string[]).includes(status)) {
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
  const id = await resolveSubmissionId(c.req.param("id") as string);
  // 传入 userId/userRole 确保管理员能看到 code/output/details
  const result = await getSubmission(id, c.get("userId"), undefined, c);
  return c.json({ data: result });
});

/**
 * 管理员删除提交记录。
 * DELETE /api/v1/admin/submissions/:id
 */
router.delete("/submissions/:id", async (c) => {
  const id = await resolveSubmissionId(c.req.param("id") as string);
  await deleteSubmission(id);
  return c.body(null, 204);
});

/**
 * 管理员查看评测队列健康状态。
 * GET /api/v1/admin/queue/health
 */
router.get("/queue/health", async (c) => {
  const health = await getQueueHealth();
  return c.json(health);
});

/** 管理员移除尚未领取的评测任务。 */
router.delete("/queue/submissions/:id", async (c) => {
  const id = await resolveSubmissionId(c.req.param("id") as string);
  await removePendingSubmission(id);
  return c.body(null, 204);
});

/**
 * 管理员重测提交。
 * POST /api/v1/admin/submissions/:id/rejudge
 */
router.post("/submissions/:id/rejudge", async (c) => {
  const id = await resolveSubmissionId(c.req.param("id") as string);
  await rejudgeSubmission(id);
  return c.json({ data: { message: "重测任务已提交", submission_id: id } });
});

/**
 * 管理员批量重测题目的所有已完结提交。
 * POST /api/v1/admin/problems/:id/rejudge
 */
router.post("/problems/:id/rejudge", async (c) => {
  const problem = await resolveProblem(c.req.param("id") as string);
  const id = problem.id;
  const result = await rejudgeProblemSubmissions(id);
  return c.json({
    data: {
      message: "批量重测任务已提交",
      problem_id: id,
      ...result,
    },
  });
});

export default router;
