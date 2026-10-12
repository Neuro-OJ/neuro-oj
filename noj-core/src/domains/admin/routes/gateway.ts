import { Hono } from "hono";
import type { AuthEnv } from "./../../identity/index.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import { adminAudit } from "../services/admin-audit.ts";
import { adminVersionMiddleware } from "../middleware/admin-version.ts";
import {
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../../shared/base/errors.ts";
import {
  createLlmProvider,
  listLlmProviders,
  LlmGatewayError,
  type LlmProviderInput,
  type LlmQuotaInput,
  type LlmUsageQuery,
  queryLlmUsage,
  testLlmProvider,
  updateLlmProvider,
  upsertLlmQuota,
} from "../../gateway/services/llm.ts";
import {
  deleteLlmModelAlias,
  listLlmModelAliases,
  listProblemsUsingAlias,
  type LlmModelAliasInput,
  upsertLlmModelAlias,
} from "../../gateway/services/llm-model-aliases.ts";

/**
 * 管理端 LLM Gateway 路由（挂载前缀 /api/v1/admin）。
 *
 * 提供：
 * - GET/POST /llm/providers         Provider 列表 / 新增
 * - PUT /llm/providers/:id          Provider 更新
 * - POST /llm/providers/:id/test    Provider 连接测试
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
 * body: { name, base_url, api_key, cost_per_1k_tokens?, enabled? }
 * 响应：201 `{ data: LlmProviderView }`；缺少必填字段返回 400 `{ error }`。
 */
router.post("/llm/providers", async (c) => {
  const body = await parseJsonBody<LlmProviderInput>(c);
  if (!body.name || !body.base_url || !body.api_key) {
    return c.json({ error: "缺少必填字段" }, 400);
  }
  const data = await createLlmProvider(body);
  await adminAudit(
    "llm_provider.create",
    { action: "llm_provider.create", name: body.name },
    { type: "llm_provider", id: data.id },
  );
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
router.put(
  "/llm/providers/:id",
  adminVersionMiddleware(async (c) => {
    const id = c.req.param("id") as string;
    return (await listLlmProviders()).find((p) => p.id === id)?.updated_at;
  }),
  async (c) => {
    const id = c.req.param("id") as string;
    const body = await parseJsonBody<Partial<LlmProviderInput>>(c);
    const data = await updateLlmProvider(id, body);
    await adminAudit(
      "llm_provider.update",
      { action: "llm_provider.update", id, name: body.name },
      { type: "llm_provider", id },
    );
    return c.json({ data });
  },
);

/**
 * 上游连接测试的失败原因（返回给管理员的可读提示）。
 *
 * 只收录"上游不通"类错误：它们是测试的**正常结果**，以 200 + status=failed
 * 返回，前端直接展示原因；Provider 不存在、gateway 不可用等仍走 mapLlmError。
 */
const PROVIDER_TEST_FAILURES: Record<string, string> = {
  provider_auth_failed: "上游鉴权失败：API Key 无效，或该 Key 无权访问此模型",
  provider_rate_limited: "上游限流（429）：请稍后重试，或检查账户额度",
  provider_unavailable: "无法连接上游：网络不通或 10 秒内无响应",
  provider_error: "上游返回错误：请检查 Base URL 与模型名称是否正确",
  provider_base_url_blocked:
    "Base URL 不被允许：仅支持 https 公网地址；内网自建模型请在网关 NOJ_LLM_UPSTREAM_ALLOWED_HOSTS 中放行该主机",
};

/**
 * 将连接测试抛出的错误转换为测试结果；非上游类错误返回 null，由调用方重新抛出。
 */
export function describeProviderTestFailure(
  error: unknown,
): { code: string; message: string } | null {
  if (!(error instanceof LlmGatewayError)) return null;
  const message = PROVIDER_TEST_FAILURES[error.code];
  return message ? { code: error.code, message } : null;
}

/**
 * 测试 LLM Provider 连接。
 * POST /api/v1/admin/llm/providers/:id/test
 *
 * 权限/认证：管理员（adminMiddleware 组级保护）。
 * path: :id = Provider ID
 * body: { model }（用于测试的模型名称，必填）
 * 说明：gateway 用已保存的 Key 向上游发起 1 token 的真实请求，会产生极少量费用。
 * 响应：`{ data: { status: "ok" | "failed", model, latency_ms, code?, message? } }`；
 * 缺少模型返回 400，Provider 不存在返回 404，gateway 不可用返回 503。
 */
router.post("/llm/providers/:id/test", async (c) => {
  const id = c.req.param("id") as string;
  const body = await parseJsonBody<{ model?: unknown }>(c);
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  if (!model) {
    throw new BadRequestError("请填写要测试的模型名称", "model_required");
  }
  const startedAt = performance.now();
  try {
    await testLlmProvider(id, model);
  } catch (error) {
    const failure = describeProviderTestFailure(error);
    if (!failure) throw error;
    return c.json({
      data: {
        status: "failed",
        model,
        latency_ms: Math.round(performance.now() - startedAt),
        ...failure,
      },
    });
  }
  return c.json({
    data: {
      status: "ok",
      model,
      latency_ms: Math.round(performance.now() - startedAt),
    },
  });
});

/**
 * 模型别名列表。
 * GET /api/v1/admin/llm/model-aliases
 *
 * 权限/认证：管理员（adminMiddleware 组级保护）。
 * 响应：`{ data: (LlmModelAlias & { problem_count: number })[] }`。
 */
router.get("/llm/model-aliases", async (c) => {
  const rows = await listLlmModelAliases();
  const data = await Promise.all(
    rows.map(async (r) => ({
      ...r,
      problem_count: (await listProblemsUsingAlias(r.alias)).length,
    })),
  );
  return c.json({ data });
});

/**
 * 新增或更新模型别名。
 * PUT /api/v1/admin/llm/model-aliases/:alias
 *
 * body: { provider_id, model, description? }；`default` 为保留别名。
 * 说明：改映射只影响此后新建的评测尝试，已冻结的尝试与重测不受影响。
 */
router.put("/llm/model-aliases/:alias", async (c) => {
  const alias = c.req.param("alias") as string;
  const body = await parseJsonBody<LlmModelAliasInput>(c);
  const data = await upsertLlmModelAlias(alias, body, c.get("userId"));
  await adminAudit(
    "llm_model_alias.upsert",
    { action: "llm_model_alias.upsert", alias },
    { type: "llm_model_alias", id: alias },
  );
  return c.json({ data });
});

/**
 * 删除模型别名。
 * DELETE /api/v1/admin/llm/model-aliases/:alias?force=true
 *
 * 被题目引用时默认返回 409 并列出题目 ID；`force=true` 强制删除
 * （这些题的后续提交会返回 400，已冻结的重测不受影响）。
 */
router.delete("/llm/model-aliases/:alias", async (c) => {
  const alias = c.req.param("alias") as string;
  const used = await listProblemsUsingAlias(alias);
  if (used.length > 0 && c.req.query("force") !== "true") {
    return c.json({
      error: `该别名被 ${used.length} 道题引用，删除后这些题的提交将失败`,
      code: "ALIAS_IN_USE",
      problem_ids: used,
    }, 409);
  }
  if (!(await deleteLlmModelAlias(alias))) {
    throw new NotFoundError("模型别名不存在");
  }
  await adminAudit(
    "llm_model_alias.delete",
    { action: "llm_model_alias.delete", alias },
    { type: "llm_model_alias", id: alias },
  );
  return c.body(null, 204);
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
 * 说明：透传 gateway `GET /internal/quotas`（`llm_quotas` 全表，按创建时间倒序），
 * 供管理后台「LLM 配额」页使用（issue #579）。
 * 响应：`{ data: unknown[] }`（gateway `llm_quotas` 行原样透传）。
 */
router.get("/llm/quotas", async (c) => {
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
  await adminAudit(
    "llm_quota.upsert",
    { action: "llm_quota.upsert", id: data?.id ?? null },
    data?.id ? { type: "llm_quota", id: data.id } : undefined,
  );
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
    // 出站校验拦截（G-03）：给管理员可操作的提示，而非原始错误码
    if (error.code === "provider_base_url_blocked") {
      throw new BadRequestError(
        "Base URL 不被允许：仅支持 https 公网地址；内网自建模型请在网关 NOJ_LLM_UPSTREAM_ALLOWED_HOSTS 中放行该主机",
        error.code,
      );
    }
    if (error.status === 400) throw new BadRequestError(error.code, error.code);
    throw new BadRequestError("模型服务暂时不可用", "LLM_GATEWAY_UNAVAILABLE");
  }
  throw error;
}

export default router;
