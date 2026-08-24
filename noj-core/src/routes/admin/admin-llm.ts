import { Hono } from "hono";
import type { AuthEnv } from "../../middleware/auth.ts";
import { parseJsonBody } from "../../lib/request.ts";
import {
  createLlmProvider,
  listLlmProviders,
  type LlmProviderInput,
  type LlmQuotaInput,
  type LlmUsageQuery,
  queryLlmUsage,
  updateLlmProvider,
  upsertLlmQuota,
} from "../../services/llm.ts";

/**
 * 管理端 LLM Gateway 路由（挂载前缀 /api/v1/admin）。
 *
 * 提供：
 * - GET/POST /llm/providers         Provider 列表 / 新增
 * - PUT /llm/providers/:id          Provider 更新
 * - GET /llm/usage                  用量查询
 * - GET/POST /llm/quotas            配额查询 / 新增或更新
 */
const router = new Hono<AuthEnv>();

router.get("/llm/providers", async (c) => {
  const data = await listLlmProviders();
  return c.json({ data });
});

router.post("/llm/providers", async (c) => {
  const body = await parseJsonBody<LlmProviderInput>(c);
  if (!body.name || !body.base_url || !body.model || !body.api_key) {
    return c.json({ error: "缺少必填字段" }, 400);
  }
  const data = await createLlmProvider(body);
  return c.json({ data }, 201);
});

router.put("/llm/providers/:id", async (c) => {
  const id = c.req.param("id") as string;
  const body = await parseJsonBody<Partial<LlmProviderInput>>(c);
  const data = await updateLlmProvider(id, body);
  return c.json({ data });
});

router.get("/llm/usage", async (c) => {
  const query: LlmUsageQuery = {
    submission_id: c.req.query("submission_id") || undefined,
    user_id: c.req.query("user_id") || undefined,
    problem_id: c.req.query("problem_id") || undefined,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
  };
  const data = await queryLlmUsage(query);
  return c.json({ data });
});

router.get("/llm/quotas", async (c) => {
  // 配额查询由 gateway 内部 API 提供；当前通过 usage 服务简化返回空列表，
  // 后续可在 gateway 增加 /internal/quotas GET 后直接透传。
  // 这里先保留 GET 路由占位，避免前端 404。
  const data = await fetchLlmQuotas();
  return c.json({ data });
});

router.post("/llm/quotas", async (c) => {
  const body = await parseJsonBody<LlmQuotaInput>(c);
  const data = await upsertLlmQuota(body);
  return c.json({ data }, 201);
});

async function fetchLlmQuotas(): Promise<unknown[]> {
  const token = Deno.env.get("NOJ_LLM_SERVICE_TOKEN") ?? "";
  const gatewayUrl = Deno.env.get("NOJ_LLM_GATEWAY_URL") ??
    "http://localhost:8001";
  const res = await fetch(`${gatewayUrl}/internal/quotas`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const body = await res.json().catch(() => null) as
    | { data?: unknown[] }
    | null;
  return body?.data ?? [];
}

export default router;
