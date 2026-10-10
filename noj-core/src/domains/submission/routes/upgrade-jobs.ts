/**
 * 用户升级任务路由（Handbook §4.4）。
 *
 * - `POST /submission-upgrade-jobs`：受理升级（`Idempotency-Key` 必填）；
 * - `GET  /submission-upgrade-jobs/:id`：本人可读，管理员可读任意。
 *
 * 升级只创建新提交（沿用原用户、记录升级来源、使用当前时间），原提交与原成绩完全
 * 不动；新提交仍执行正常提交权限/竞赛限制，受理侧已固定目标版本。
 */

import { Hono } from "hono";
import {
  type AuthEnv,
  authMiddleware,
  checkPermission,
} from "./../../identity/index.ts";
import {
  BadRequestError,
  NotFoundError,
} from "./../../../shared/base/errors.ts";
import {
  acceptUpgradeJob,
  getUpgradeJobForActor,
  type UpgradeRequest,
} from "../services/versioning/upgrade-jobs.ts";

const router = new Hono<AuthEnv>();

/**
 * 受理升级任务。
 *
 * POST /api/v1/submission-upgrade-jobs
 */
router.post("/submission-upgrade-jobs", authMiddleware, async (c) => {
  const actorId = c.get("userId") as string;
  const idempotencyKey = c.req.header("idempotency-key")?.trim() ?? "";
  const body = await c.req.json<UpgradeRequest>().catch(() => null);
  if (!body || typeof body !== "object" || !Array.isArray(body.submissions)) {
    throw new BadRequestError("缺少必填字段：submissions");
  }
  const accepted = await acceptUpgradeJob(actorId, body, idempotencyKey);
  return c.json({ data: accepted }, 202);
});

/**
 * 读取升级任务：本人或管理员。
 *
 * GET /api/v1/submission-upgrade-jobs/:id
 */
router.get("/submission-upgrade-jobs/:id", authMiddleware, async (c) => {
  const actorId = c.get("userId") as string;
  const isAdmin = await checkPermission(c, "submission:read_all");
  const job = await getUpgradeJobForActor(
    c.req.param("id") as string,
    actorId,
    isAdmin,
  );
  if (!job) throw new NotFoundError("任务不存在");
  return c.json({ data: job });
});

export default router;
