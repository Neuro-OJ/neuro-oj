import { Hono } from "hono";
import type { AuthEnv } from "./../../identity/index.ts";
import {
  BadRequestError,
  NotFoundError,
} from "./../../../shared/base/errors.ts";
import {
  acceptRejudgeJob,
  getRejudgeJob,
  listRejudgeJobItems,
  type RejudgeRequest,
  retryRejudgeJob,
} from "../../submission/services/versioning/rejudge-jobs.ts";
import type { SubmissionJobItemStatus } from "../../../shared/versioning/types.ts";

/**
 * 批量重测任务路由（挂载前缀 `/api/v1/admin/submission-jobs`，见 admin/index.ts）。
 *
 * Handbook §4.3：
 * - `POST /`        受理任务（`Idempotency-Key` 必填，返回 202 + 任务 ID）
 * - `GET  /:id`     任务详情（状态与条目计数）
 * - `GET  /:id/items` 条目列表（分页 + 可选 status 过滤）
 * - `POST /:id/retry` 重试 failed/skipped 条目（生成关联新任务，不改有效策略）
 */

const router = new Hono<AuthEnv>();

/** 受理批量重测任务。 */
router.post("/", async (c) => {
  const actorId = (c.get("userId") as string | undefined) ?? "0";
  const idempotencyKey = c.req.header("idempotency-key")?.trim() ?? "";
  const body = await c.req.json<RejudgeRequest>().catch(() => null);
  if (!body || typeof body !== "object") {
    throw new BadRequestError("请求体必须是 JSON 对象");
  }
  const accepted = await acceptRejudgeJob(actorId, body, idempotencyKey);
  return c.json({ data: accepted }, 202);
});

/** 任务详情。 */
router.get("/:id", async (c) => {
  const job = await getRejudgeJob(c.req.param("id") as string);
  if (!job) throw new NotFoundError("任务不存在");
  return c.json({ data: job });
});

/** 任务条目列表。 */
router.get("/:id/items", async (c) => {
  const jobId = c.req.param("id") as string;
  const job = await getRejudgeJob(jobId);
  if (!job) throw new NotFoundError("任务不存在");
  const page = Number(c.req.query("page") ?? "1");
  const perPage = Number(c.req.query("per_page") ?? "20");
  const status = c.req.query("status") as SubmissionJobItemStatus | undefined;
  const items = await listRejudgeJobItems(jobId, { page, perPage, status });
  return c.json({
    data: items.data,
    total: items.total,
    page: Number.isFinite(page) && page > 0 ? page : 1,
    per_page: Number.isFinite(perPage) && perPage > 0 ? perPage : 20,
  });
});

/** 重试失败/跳过条目（生成关联新任务）。 */
router.post("/:id/retry", async (c) => {
  const actorId = (c.get("userId") as string | undefined) ?? "0";
  const idempotencyKey = c.req.header("idempotency-key")?.trim() ?? "";
  const accepted = await retryRejudgeJob(
    actorId,
    c.req.param("id") as string,
    idempotencyKey,
  );
  return c.json({ data: accepted }, 202);
});

export default router;
