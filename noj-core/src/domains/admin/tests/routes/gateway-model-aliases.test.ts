import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import router from "../../routes/gateway.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { llmModelAliases, problems } from "../../../../shared/db/schema.ts";
import { upsertLlmModelAlias } from "../../../gateway/index.ts";
import { ROOT_USER_ID } from "../../../../shared/base/constants.ts";

/** 桩 gateway（Provider 恒存在）+ 管理员上下文；用毕清理别名表。 */
async function withStub(fn: (app: Hono) => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const prev = {
    token: Deno.env.get("NOJ_LLM_SERVICE_TOKEN"),
    url: Deno.env.get("NOJ_LLM_GATEWAY_URL"),
  };
  Deno.env.set("NOJ_LLM_SERVICE_TOKEN", "test-service-token-0123456789abcdef");
  Deno.env.set("NOJ_LLM_GATEWAY_URL", "http://gateway.test");
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            id: "prov-a",
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
      ),
    )) as typeof fetch;
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
  headers: { "Content-Type": "application/json" },
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
    });
    assertEquals(del.status, 204);
    const missing = await app.request("/llm/model-aliases/fast", {
      method: "DELETE",
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
    await upsertLlmModelAlias(
      "fast",
      { provider_id: "prov-a", model: "m" },
      ROOT_USER_ID,
    );
    const id = `alias-test-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await getDb().insert(problems).values({
      id,
      title: id,
      description: "d",
      type: "P",
      number: 900000 + Math.floor(Math.random() * 90000),
      owner_id: "0",
      difficulty: "easy",
      judge_type: "dual",
      llm_config: { models: ["fast"] },
      created_at: now,
      updated_at: now,
    });
    try {
      const list = await (await app.request("/llm/model-aliases")).json();
      assertEquals(list.data[0].problem_count, 1);
      const res = await app.request("/llm/model-aliases/fast", {
        method: "DELETE",
      });
      assertEquals(res.status, 409);
      assertEquals((await res.json()).problem_ids, [id]);
      const forced = await app.request("/llm/model-aliases/fast?force=true", {
        method: "DELETE",
      });
      assertEquals(forced.status, 204);
    } finally {
      const { eq } = await import("drizzle-orm");
      await getDb().delete(problems).where(eq(problems.id, id));
    }
  });
});
