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

export function createInternalRouter(deps: InternalDeps): Hono {
  const app = new Hono();
  app.use("*", requireServiceToken(deps.config.serviceToken));

  app.get("/internal/providers", async (c) => {
    const providers = await listProviders(deps.db);
    return c.json({ data: providers });
  });

  app.post("/internal/providers", async (c) => {
    const body = await c.req.json<ProviderInput>();
    if (!body.name || !body.base_url || !body.model || !body.api_key) {
      return c.json({ error: "missing_required_fields" }, 400);
    }
    const provider = await createProvider(deps.db, body, deps.config.storeKey);
    return c.json({ data: provider }, 201);
  });

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

  app.get("/internal/usage", async (c) => {
    const submissionId = c.req.query("submission_id");
    const userId = c.req.query("user_id");
    const problemId = c.req.query("problem_id");
    const limit = Math.min(Number(c.req.query("limit") ?? "100"), 1000);

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
    const where = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const rows = await deps.db.unsafe(
      `SELECT * FROM llm_usage ${where} ORDER BY created_at DESC LIMIT ${limit}`,
      ...(params as never[]),
    );
    return c.json({ data: rows });
  });

  app.get("/internal/quotas", async (c) => {
    const rows = await deps
      .db`SELECT * FROM llm_quotas ORDER BY created_at DESC`;
    return c.json({ data: rows });
  });

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
