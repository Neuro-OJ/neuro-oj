import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../../../shared/db/connection.ts";
import { systemSettings } from "../../../shared/db/schema.ts";
import { UnauthorizedError } from "../../../shared/base/errors.ts";
import { validateWorkspaceSetting } from "../../../shared/workspace/resource-policy.ts";
import { getSetting } from "../services/system-settings.ts";

/** Gateway 每次调用前读取持久上限；内部凭据独立于用户登录和域角色。 */
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
  return c.json({
    data: validateWorkspaceSetting("domain_llm_quota_caps", text),
  });
});
