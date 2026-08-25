/**
 * core↔gateway 内部管理 API（使用 NOJ_LLM_SERVICE_TOKEN 鉴权）。
 */
import { Hono } from "hono";
import type { Db } from "../db.ts";
import type { GatewayConfig } from "../config.ts";
import { requireServiceToken } from "../auth.ts";
import {
  createProvider,
  listProviders,
  type ProviderInput,
  updateProvider,
} from "../providers.ts";

export interface InternalDeps {
  config: GatewayConfig;
  db: Db;
}

/** 创建 core↔gateway 内部管理路由；所有端点均需服务间 Bearer Token。 */
export function createInternalRouter(deps: InternalDeps): Hono {
  const app = new Hono();
  app.use("*", requireServiceToken(deps.config.serviceToken));

  // Provider 列表（Key 脱敏）
  app.get("/internal/providers", async (c) => {
    const providers = await listProviders(deps.db, deps.config.storeKey);
    return c.json({ data: providers });
  });

  // Provider 精简信息（不含加密 Key）
  app.get("/internal/providers/:id", async (c) => {
    const id = c.req.param("id");
    const rows = await deps
      .db`SELECT id, name, base_url, model, cost_per_1k_tokens, enabled, created_at, updated_at FROM llm_providers WHERE id = ${id}`;
    if (rows.length === 0) {
      return c.json({ error: "provider_not_found" }, 404);
    }
    return c.json({ data: rows[0] });
  });

  // 新增 Provider
  app.post("/internal/providers", async (c) => {
    const body = await c.req.json<ProviderInput>();
    if (!body.name || !body.base_url || !body.model || !body.api_key) {
      return c.json({ error: "missing_required_fields" }, 400);
    }
    const provider = await createProvider(deps.db, body, deps.config.storeKey);
    return c.json({ data: provider }, 201);
  });

  // 更新 Provider
  app.put("/internal/providers/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<Partial<ProviderInput>>();
    try {
      const provider = await updateProvider(
        deps.db,
        id,
        body,
        deps.config.storeKey,
      );
      return c.json({ data: provider });
    } catch (err) {
      const message = err instanceof Error ? err.message : "update_failed";
      return c.json(
        { error: message },
        message === "provider_not_found" ? 404 : 400,
      );
    }
  });

  // 用量查询（支持多条件筛选 + 分页）
  app.get("/internal/usage", async (c) => {
    const submissionId = c.req.query("submission_id");
    const userId = c.req.query("user_id");
    const problemId = c.req.query("problem_id");
    const providerId = c.req.query("provider_id");
    const status = c.req.query("status");
    const startTime = c.req.query("start_time");
    const endTime = c.req.query("end_time");
    const rawLimit = Number(c.req.query("limit") ?? "100");
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(1, Math.floor(rawLimit)), 1000)
      : 100;
    const page = Math.max(
      1,
      Math.floor(Number(c.req.query("page") ?? "1") || 1),
    );

    const conditions: string[] = [];
    const params: string[] = [];
    if (submissionId) {
      params.push(submissionId);
      conditions.push(`submission_id = $${params.length}`);
    }
    if (userId) {
      params.push(userId);
      conditions.push(`user_id = $${params.length}`);
    }
    if (problemId) {
      params.push(problemId);
      conditions.push(`problem_id = $${params.length}`);
    }
    if (providerId) {
      params.push(providerId);
      conditions.push(`provider_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    if (startTime) {
      params.push(startTime);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (endTime) {
      params.push(endTime);
      conditions.push(`created_at <= $${params.length}`);
    }
    const where = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const rows = await deps.db.unsafe(
      `SELECT * FROM llm_usage ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${
        (page - 1) * limit
      }`,
      params,
    );
    return c.json({ data: rows });
  });

  // 配额列表
  app.get("/internal/quotas", async (c) => {
    const rows = await deps
      .db`SELECT * FROM llm_quotas ORDER BY created_at DESC`;
    return c.json({ data: rows });
  });

  // 新增或更新配额（按 id upsert）
  app.post("/internal/quotas", async (c) => {
    const body = await c.req.json<{
      id?: string;
      scope_type: string;
      scope_id?: string;
      window_type?: string;
      max_calls?: number;
      max_tokens?: number;
      max_cost?: number;
    }>();
    if (
      !body.scope_type ||
      !["user", "problem", "global"].includes(body.scope_type)
    ) {
      return c.json({ error: "invalid_scope_type" }, 400);
    }
    if (
      body.window_type !== undefined &&
      !["day", "month"].includes(body.window_type)
    ) {
      return c.json({ error: "invalid_window_type" }, 400);
    }
    const id = body.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const scopeId = body.scope_id ?? "";
    const windowType = body.window_type ?? "day";
    await deps.db`
      INSERT INTO llm_quotas (id, scope_type, scope_id, window_type, max_calls, max_tokens, max_cost, created_at, updated_at)
      VALUES (${id}, ${body.scope_type}, ${scopeId}, ${windowType}, ${
      body.max_calls ?? 0
    }, ${body.max_tokens ?? 0}, ${body.max_cost ?? 0}, ${now}, ${now})
      ON CONFLICT (id) DO UPDATE SET
        scope_type = EXCLUDED.scope_type,
        scope_id = EXCLUDED.scope_id,
        window_type = EXCLUDED.window_type,
        max_calls = EXCLUDED.max_calls,
        max_tokens = EXCLUDED.max_tokens,
        max_cost = EXCLUDED.max_cost,
        updated_at = EXCLUDED.updated_at
    `;
    return c.json({ data: { id } }, 201);
  });

  return app;
}
