import { Hono } from "hono";
import type { AuthEnv } from "./../../identity/index.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import {
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../../lib/errors.ts";
import {
  createLlmProvider,
  listLlmProviders,
  LlmGatewayError,
  type LlmProviderInput,
  type LlmQuotaInput,
  type LlmUsageQuery,
  queryLlmUsage,
  updateLlmProvider,
  upsertLlmQuota,
} from "../services/llm.ts";

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

/**
 * 将 LLM Gateway 错误统一转换为管理端 API 的业务错误。
 *
 * 该错误处理器覆盖本 router 的所有入口，避免 Provider 读写、用量和配额
 * 路由各自遗漏错误处理。通过抛出 AppError 交由父级全局处理器统一输出。
 */
router.onError((error) => mapLlmError(error));

/**
 * 获取 LLM Provider 列表。
 * GET /api/v1/admin/llm/providers
 *
 * 权限/认证：管理员（adminMiddleware 组级保护）。
 * 响应：`{ data: LlmProviderView[] }`，Key 已由 gateway 脱敏。
 */
router.get("/llm/providers", async (c) => {
  const data = await listLlmProviders();
  return c.json({ data });
});

/**
 * 新增 LLM Provider。
 * POST /api/v1/admin/llm/providers
 *
 * 权限/认证：管理员（adminMiddleware 组级保护）。
 * body: { name, base_url, model, api_key, cost_per_1k_tokens?, enabled? }
 * 响应：201 `{ data: LlmProviderView }`；缺少必填字段返回 400 `{ error }`。
 */
router.post("/llm/providers", async (c) => {
  const body = await parseJsonBody<LlmProviderInput>(c);
  if (!body.name || !body.base_url || !body.model || !body.api_key) {
    return c.json({ error: "缺少必填字段" }, 400);
  }
  const data = await createLlmProvider(body);
  return c.json({ data }, 201);
});

/**
 * 更新 LLM Provider 的指定字段。
 * PUT /api/v1/admin/llm/providers/:id
 *
 * 权限/认证：管理员（adminMiddleware 组级保护）。
 * path: :id = Provider ID
 * body: Partial<LlmProviderInput>（部分更新）
 * 响应：`{ data: LlmProviderView }`。
 */
router.put("/llm/providers/:id", async (c) => {
  const id = c.req.param("id") as string;
  const body = await parseJsonBody<Partial<LlmProviderInput>>(c);
  const data = await updateLlmProvider(id, body);
  return c.json({ data });
});

/**
 * 查询 LLM 用量记录。
 * GET /api/v1/admin/llm/usage
 *
 * 权限/认证：管理员（adminMiddleware 组级保护）。
 * query 可选：submission_id / user_id / problem_id / provider_id / status /
 * start_time / end_time / limit / page（透传 gateway）。
 * 响应：`{ data: unknown[] }`（用量记录列表）。
 */
router.get("/llm/usage", async (c) => {
  const query: LlmUsageQuery = {
    submission_id: c.req.query("submission_id") || undefined,
    user_id: c.req.query("user_id") || undefined,
    problem_id: c.req.query("problem_id") || undefined,
    provider_id: c.req.query("provider_id") || undefined,
    status: c.req.query("status") || undefined,
    start_time: c.req.query("start_time") || undefined,
    end_time: c.req.query("end_time") || undefined,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    page: c.req.query("page") ? Number(c.req.query("page")) : undefined,
  };
  const data = await queryLlmUsage(query);
  return c.json({ data });
});

/**
 * 查询 LLM 配额列表。
 * GET /api/v1/admin/llm/quotas
 *
 * 权限/认证：管理员（adminMiddleware 组级保护）。
 * 说明：配额查询由 gateway 内部 API 提供；当前为占位路由，返回空列表，
 * 后续可在 gateway 增加 /internal/quotas GET 后直接透传，避免前端 404。
 * 响应：`{ data: unknown[] }`。
 */
router.get("/llm/quotas", async (c) => {
  // 配额查询由 gateway 内部 API 提供；当前通过 usage 服务简化返回空列表，
  // 后续可在 gateway 增加 /internal/quotas GET 后直接透传。
  // 这里先保留 GET 路由占位，避免前端 404。
  const data = await fetchLlmQuotas();
  return c.json({ data });
});

/**
 * 新增或更新 LLM 配额。
 * POST /api/v1/admin/llm/quotas
 *
 * 权限/认证：管理员（adminMiddleware 组级保护）。
 * body: LlmQuotaInput（按 id upsert：含 id 则更新，否则新增）。
 * 响应：201 `{ data: { id: string } }`。
 */
router.post("/llm/quotas", async (c) => {
  const body = await parseJsonBody<LlmQuotaInput>(c);
  const data = await upsertLlmQuota(body);
  return c.json({ data }, 201);
});

/**
 * 向 LLM Gateway 内部管理 API 请求配额列表。
 *
 * 读取 NOJ_LLM_SERVICE_TOKEN 与 NOJ_LLM_GATEWAY_URL 环境变量，
 * 携带承载 Token 调用 gateway 的 /internal/quotas 端点；失败时抛出异常。
 *
 * @returns 配额列表（无数据时返回空数组）
 * @throws {Error} gateway 返回非 2xx 时抛出，携带状态码
 */
async function fetchLlmQuotas(): Promise<unknown[]> {
  const token = Deno.env.get("NOJ_LLM_SERVICE_TOKEN") ?? "";
  const gatewayUrl = Deno.env.get("NOJ_LLM_GATEWAY_URL") ??
    "http://localhost:8001";
  let res: Response;
  try {
    res = await fetch(`${gatewayUrl}/internal/quotas`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new LlmGatewayError(503, "gateway_unavailable");
  }
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null) as
      | { error?: unknown }
      | null;
    throw new LlmGatewayError(
      res.status,
      typeof errorBody?.error === "string" ? errorBody.error : "gateway_error",
    );
  }
  const body = await res.json().catch(() => null) as
    | { data?: unknown[] }
    | null;
  return body?.data ?? [];
}

/**
 * 将 LLM Gateway 转发错误映射为可读的 4xx 而非 500。
 *
 * core 的 request() 对 gateway 任何非 2xx 都抛 LlmGatewayError（非 AppError），
 * 若不在路由层捕获会落入全局 onError 变成 500 INTERNAL_ERROR。
 */
export function mapLlmError(error: unknown): never {
  if (error instanceof LlmGatewayError) {
    if (error.status === 404) throw new NotFoundError("模型配置不存在");
    if (error.status >= 500) {
      throw new ServiceUnavailableError("模型服务暂时不可用");
    }
    if (error.status === 400) throw new BadRequestError(error.code, error.code);
    throw new BadRequestError("模型服务暂时不可用", "LLM_GATEWAY_UNAVAILABLE");
  }
  throw error;
}

export default router;
