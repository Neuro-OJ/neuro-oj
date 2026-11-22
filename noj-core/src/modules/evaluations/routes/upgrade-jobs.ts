/**
 * 用户升级任务路由（Handbook §4.4）。
 *
 * - `POST /submission-upgrade-jobs`：受理升级（`Idempotency-Key` 必填）；
 * - `GET  /submission-upgrade-jobs/:id`：本人可读，管理员可读任意。
 *
 * 升级只创建新提交（沿用原用户、记录升级来源、使用当前时间），原提交与原成绩完全
 * 不动；新提交仍执行正常提交权限/竞赛限制，受理侧已固定目标版本。
 *
 * **两级额度**（2026-10-11 复审问题 9）：本路由只做任务级限流（每分钟 3 次受理、
 * 每次最多 500 条），逐副本的**正常提交额度**在 worker 创建副本时按**原用户**占用
 * （`consumeSubmissionQuotaForUpgrade`）；额度不足只延期、不失败。
 */

import { Hono } from "hono";
import { authMiddleware } from "../../access/identity/middleware/auth.ts";
import { type AuthEnv } from "../../../shared/http/hono-env.ts";
import { checkPermission } from "../../access/contracts/cross-module/identity_services_security_permissions.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";
import { getUpgradeJobForActor } from "../services/versioning/upgrade-jobs.ts";

const router = new Hono<AuthEnv>();

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
