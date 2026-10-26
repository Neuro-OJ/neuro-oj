import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../../../../shared/db/connection.ts";
import { systemSettings } from "../../../../shared/db/schema.ts";
import { UnauthorizedError } from "../../../../shared/base/errors.ts";
import { validateWorkspaceSetting } from "../../../../shared/workspace/resource-policy.ts";
import { getSetting } from "../services/system-settings.ts";

/**
 * 旧 Core 政策读取端点（迁移期只读归档）。
 *
 * P5 之后政策权威在 Gateway 本地 `llm_policy`，Gateway **不再**调用本端点。
 * 保留它的唯一用途是：
 * - 迁移窗口内供运维核对旧值（`exportGatewayPolicySnapshot` 也直接读设置）；
 * - 兼容尚未升级的旧 Gateway 进程（协调发布期间）。
 *
 * 一旦协调发布完成，正常业务路径不得再依赖它；下一个删除周期会移除本路由。
 * 这里显式标注 deprecated，避免被误当作权威来源重新接入。
 */
export const internalLlmPolicyRouter = new Hono();
internalLlmPolicyRouter.get("/internal/llm/quota-caps", async (c) => {
  const configured = String(getSetting("NOJ_LLM_SERVICE_TOKEN")?.value ?? "");
  const supplied = c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "";
  const encoder = new TextEncoder(),
    expected = encoder.encode(configured),
    actual = encoder.encode(supplied);
  if (
    !configured || expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) throw new UnauthorizedError("内部服务凭据无效");
  const [row] = await getDb().select({ value: systemSettings.value }).from(
    systemSettings,
  ).where(eq(systemSettings.key, "domain_llm_quota_caps"));
  const fallback = JSON.stringify({
    day: { max_calls: null, max_tokens: null, max_cost: null },
    month: { max_calls: null, max_tokens: null, max_cost: null },
  });
  const text = row ? JSON.parse(row.value) as string : fallback;
  c.header("Cache-Control", "no-store");
  c.header("Deprecation", "true");
  c.header("Sunset", "policy-authority-moved-to-gateway");
  return c.json({
    data: validateWorkspaceSetting("domain_llm_quota_caps", text),
  });
});
