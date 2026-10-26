import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import { createUserToken, jsonRequest } from "../../../../../tests/helper.ts";
import { updateSetting } from "../../../system/index.ts";

Deno.test("域 LLM HTTP：caps保持data数组，Provider及配额版本透传，旧入口不绕过CAS", async () => {
  await resetDbForTest();
  const token = await createUserToken("admin");
  const app = createApp();
  const { data: domain } = await (await jsonRequest(app, "/api/v1/domains", {
    method: "POST",
    token,
    body: { slug: "llm-cas-school", name: "学校", preset: "education" },
  })).json();
  const caps = {
    day: { max_calls: 5, max_tokens: 100, max_cost: null },
    month: { max_calls: null, max_tokens: null, max_cost: null },
  };
  await updateSetting(
    "domain_llm_quota_caps",
    JSON.stringify(caps),
    domain.owner_id,
  );
  const originalFetch = globalThis.fetch;
  const originalToken = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
  Deno.env.set(
    "NOJ_LLM_SERVICE_TOKEN",
    "llm-cas-service-token-0123456789abcdef",
  );
  let writes = 0;
  globalThis.fetch = (url, init) => {
    const path = String(url);
    const headers = new Headers(init?.headers);
    if (!init?.method || init.method === "GET") {
      return Promise.resolve(
        Response.json({
          data: [{
            id: "quota",
            revision: 1,
            domain_id: domain.id,
            scope_type: "domain",
            max_calls: 5,
            max_tokens: 100,
            max_cost: null,
          }],
        }),
      );
    }
    writes++;
    if (init.method === "PUT") {
      assertEquals(headers.get("If-Match"), "1");
      return Promise.resolve(
        Response.json({ error: "revision_conflict" }, { status: 409 }),
      );
    }
    assertEquals(headers.get("If-Match"), "0");
    assertEquals(headers.get("X-Noj-Domain-Id"), domain.id);
    if (path.endsWith("/quotas")) {
      const input = JSON.parse(String(init.body));
      assertEquals(input.max_cost, null);
    }
    return Promise.resolve(
      Response.json({ data: { id: "created", revision: 1 } }, { status: 201 }),
    );
  };
  try {
    const prefix = `/api/v1/domains/${domain.slug}/llm`;
    const read = await (await jsonRequest(app, prefix + "/quotas", { token }))
      .json();
    assertEquals(Array.isArray(read.data), true);
    assertEquals(read.caps, caps);
    assertEquals(read.data[0].revision, 1);
    const provider = {
      name: "private-provider",
      base_url: "https://api.openai.com",
      api_key: "sk-test",
    };
    assertEquals(
      (await jsonRequest(app, prefix + "/providers", {
        method: "POST",
        token,
        body: provider,
      })).status,
      428,
    );
    assertEquals(writes, 0);
    assertEquals(
      (await jsonRequest(app, prefix + "/providers", {
        method: "POST",
        token,
        headers: { "If-Match": "0" },
        body: provider,
      })).status,
      201,
    );
    const conflict = await jsonRequest(app, prefix + "/providers/created", {
      method: "PUT",
      token,
      headers: { "If-Match": "1" },
      body: { enabled: false },
    });
    assertEquals(conflict.status, 409);
    assertEquals((await conflict.json()).code, "REVISION_CONFLICT");
    assertEquals(
      (await jsonRequest(app, prefix + "/quotas", {
        method: "POST",
        token,
        headers: { "If-Match": "0" },
        body: {
          scope_type: "domain",
          max_calls: 4,
          max_tokens: 99,
          max_cost: null,
        },
      })).status,
      201,
    );
    assertEquals(
      (await jsonRequest(app, "/api/v1/admin/gateway/llm/providers/created", {
        method: "PUT",
        token,
        body: { enabled: false },
      })).status,
      428,
    );
    const oldConflict = await jsonRequest(
      app,
      "/api/v1/admin/gateway/llm/providers/created",
      {
        method: "PUT",
        token,
        headers: { "If-Match": "1" },
        body: { enabled: false },
      },
    );
    assertEquals(oldConflict.status, 409);
    assertEquals((await oldConflict.json()).code, "REVISION_CONFLICT");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
    else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", originalToken);
  }
});
