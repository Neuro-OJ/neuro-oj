import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import router from "../../routes/gateway.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { llmModelAliases, problems } from "../../../../shared/db/schema.ts";
import { upsertLlmGatewayModelAlias } from "../../../../modules/platform/gateway/index.ts";
import { ROOT_USER_ID } from "../../../../shared/base/constants.ts";
import {
  DEFAULT_DOMAIN_ID,
  ensureDefaultWorkspace,
} from "../../../../modules/access/workspace/index.ts";
import {
  deleteProblemFixtures,
  publishBaselineVersionForTest,
} from "../../../../../tests/helper.ts";
import { eq } from "drizzle-orm";

/** 桩 gateway（Provider 恒存在）+ 管理员上下文；用毕清理别名表。 */
async function withStub(fn: (app: Hono) => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const prev = {
    token: Deno.env.get("NOJ_LLM_SERVICE_TOKEN"),
    url: Deno.env.get("NOJ_LLM_GATEWAY_URL"),
  };
  Deno.env.set("NOJ_LLM_SERVICE_TOKEN", "test-service-token-0123456789abcdef");
  Deno.env.set("NOJ_LLM_GATEWAY_URL", "http://gateway.test");
  const aliases = new Map<string, Record<string, unknown>>();
  globalThis.fetch = (async (input, init) => {
    await Promise.resolve();
    const url = new URL(String(input));
    if (url.pathname.endsWith("/internal/model-aliases")) {
      return new Response(JSON.stringify({ data: [...aliases.values()] }), {
        status: 200,
      });
    }
    if (url.pathname.includes("/internal/model-aliases/")) {
      const alias = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      if (init?.method === "PUT") {
        if (alias === "default" || !/^[a-z][a-z0-9_-]{0,31}$/.test(alias)) {
          return new Response(JSON.stringify({ error: "invalid_alias" }), {
            status: 400,
          });
        }
        const body = JSON.parse(String(init.body)) as {
          provider_id: string;
          model: string;
          description?: string;
        };
        const row = {
          domain_id: DEFAULT_DOMAIN_ID,
          alias,
          provider_id: body.provider_id,
          model: body.model,
          description: body.description ?? "",
          revision: (aliases.get(alias)?.revision as number ?? 0) + 1,
          updated_at: "2026-01-01T00:00:00.000Z",
          updated_by: ROOT_USER_ID,
        };
        aliases.set(alias, row);
        return new Response(JSON.stringify({ data: row }), { status: 200 });
      }
      if (init?.method === "DELETE") {
        if (!aliases.has(alias)) {
          return new Response(JSON.stringify({ error: "alias_not_found" }), {
            status: 404,
          });
        }
        aliases.delete(alias);
        return new Response(null, { status: 204 });
      }
    }
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    return new Response(
      JSON.stringify({
        data: {
          domain_id: DEFAULT_DOMAIN_ID,
          revision: 1,
          id,
          name: "stub",
          base_url: "http://stub",
          cost_per_1k_tokens: 0,
          api_key_masked: "sk-****",
          enabled: true,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const app = new Hono();
  app.use("*", async (c, next) => {
    // deno-lint-ignore no-explicit-any
    (c as any).set("userId", ROOT_USER_ID);
    await next();
  });
  app.onError((err) =>
    new Response(JSON.stringify({ error: err.message }), {
      status: (err as { status?: number }).status ?? 500,
    })
  );
  app.route("/", router);
  await getDb().delete(llmModelAliases);
  await ensureDefaultWorkspace();
  try {
    await fn(app);
  } finally {
    await getDb().delete(llmModelAliases);
    globalThis.fetch = originalFetch;
    if (prev.token === undefined) Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
    else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", prev.token);
    if (prev.url === undefined) Deno.env.delete("NOJ_LLM_GATEWAY_URL");
    else Deno.env.set("NOJ_LLM_GATEWAY_URL", prev.url);
  }
}

const json = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json", "If-Match": "0" },
  body: JSON.stringify(body),
});

Deno.test("admin gateway: 别名 PUT/GET/DELETE 往返", async () => {
  await withStub(async (app) => {
    const put = await app.request(
      "/llm/model-aliases/fast",
      json({
        provider_id: "prov-a",
        model: "Qwen/Qwen3-8B",
        description: "快",
      }),
    );
    assertEquals(put.status, 200);
    const list = await (await app.request("/llm/model-aliases")).json();
    assertEquals(list.data.length, 1);
    assertEquals(list.data[0].alias, "fast");
    assertEquals(list.data[0].problem_count, 0);
    const del = await app.request("/llm/model-aliases/fast", {
      method: "DELETE",
      headers: { "If-Match": String(list.data[0].revision) },
    });
    assertEquals(del.status, 204);
    const missing = await app.request("/llm/model-aliases/fast", {
      method: "DELETE",
      headers: { "If-Match": String(list.data[0].revision) },
    });
    assertEquals(missing.status, 404);
  });
});

Deno.test("admin gateway: default 保留名与非法别名返回 400", async () => {
  await withStub(async (app) => {
    for (const alias of ["default", "Bad"]) {
      const res = await app.request(
        `/llm/model-aliases/${alias}`,
        json({ provider_id: "prov-a", model: "m" }),
      );
      assertEquals(res.status, 400, alias);
    }
  });
});

Deno.test("admin gateway: 删除被题目引用的别名返回 409，force 可强删", async () => {
  await withStub(async (app) => {
    await upsertLlmGatewayModelAlias(
      "fast",
      { provider_id: "prov-a", model: "m" },
      DEFAULT_DOMAIN_ID,
      0,
      ROOT_USER_ID,
    );
    const id = `alias-test-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await getDb().insert(problems).values({
      id,
      title: id,
      description: "d",
      domain_id: DEFAULT_DOMAIN_ID,
      number: 900000 + Math.floor(Math.random() * 90000),
      owner_id: "0",
      difficulty: "easy",
      judge_type: "dual",
      llm_config: { models: ["fast"] },
      created_at: now,
      updated_at: now,
    });
    await publishBaselineVersionForTest(id);
    try {
      const list = await (await app.request("/llm/model-aliases")).json();
      assertEquals(list.data[0].problem_count, 1);
      const res = await app.request("/llm/model-aliases/fast", {
        method: "DELETE",
        headers: { "If-Match": String(list.data[0].revision) },
      });
      assertEquals(res.status, 409);
      assertEquals((await res.json()).problem_ids, [id]);
      const forced = await app.request("/llm/model-aliases/fast?force=true", {
        method: "DELETE",
        headers: { "If-Match": String(list.data[0].revision) },
      });
      assertEquals(forced.status, 204);
    } finally {
      await deleteProblemFixtures(eq(problems.id, id));
    }
  });
});
