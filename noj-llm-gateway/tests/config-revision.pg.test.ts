import { assertEquals } from "jsr:@std/assert@^1";
import { createDb } from "../src/db.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createInternalRouter } from "../src/routes/internal.ts";
import { testConfig } from "./helpers.ts";

const databaseUrl = Deno.env.get("NOJ_GATEWAY_TEST_DATABASE_URL");

Deno.test({
  name:
    "配置版本 PG：Provider 与配额并发同版本只有一次写入，旧版本及缺失版本拒绝",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const admin = createDb(databaseUrl!);
    const schema = "gw_revision_" + crypto.randomUUID().replaceAll("-", "");
    await admin.unsafe('CREATE SCHEMA "' + schema + '"');
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", "-csearch_path=" + schema);
    const db = createDb(url.toString());
    try {
      await runMigrations(url.toString());
      const app = createInternalRouter({ config: testConfig, db });
      const request = (
        path: string,
        body: unknown,
        revision?: number,
        domain = "school-a",
        method = "POST",
      ) =>
        app.request(path, {
          method,
          headers: {
            authorization: "Bearer " + testConfig.serviceToken,
            "content-type": "application/json",
            "X-Noj-Domain-Id": domain,
            ...(revision === undefined ? {} : { "If-Match": String(revision) }),
          },
          body: JSON.stringify(body),
        });
      assertEquals((await request("/internal/providers", {})).status, 428);
      assertEquals((await request("/internal/quotas", {})).status, 428);
      const created = await request("/internal/providers", {
        name: "source",
        base_url: "https://api.openai.com",
        api_key: "sk-test-provider",
      }, 0);
      assertEquals(created.status, 201);
      const provider = (await created.json()).data;
      assertEquals(provider.revision, 1);
      const path = "/internal/providers/" + provider.id;
      const results = await Promise.all([
        request(path, { name: "left" }, 1, "school-a", "PUT"),
        request(path, { name: "right" }, 1, "school-a", "PUT"),
      ]);
      assertEquals(results.map((result) => result.status).sort(), [200, 409]);
      const [stored] =
        await db`SELECT name,revision FROM llm_providers WHERE id=${provider.id}`;
      assertEquals(stored.revision, 2);
      assertEquals(["left", "right"].includes(stored.name), true);
      assertEquals(
        (await request(path, { enabled: false }, 1, "school-a", "PUT")).status,
        409,
      );
      assertEquals(
        (await request(path, { enabled: false }, 2, "school-b", "PUT")).status,
        404,
      );
      assertEquals(
        (await request(path, {}, 1, "school-a", "DELETE")).status,
        409,
      );
      assertEquals(
        (await request(path, {}, 2, "school-a", "DELETE")).status,
        204,
      );

      const createdQuota = await request("/internal/quotas", {
        scope_type: "domain",
        max_calls: 5,
        max_tokens: null,
        max_cost: null,
      }, 0);
      assertEquals(createdQuota.status, 201);
      const quota = (await createdQuota.json()).data;
      assertEquals(quota.revision, 1);
      const input = {
        id: quota.id,
        scope_type: "domain",
        max_tokens: null,
        max_cost: null,
      };
      const quotas = await Promise.all([
        request("/internal/quotas", { ...input, max_calls: 3 }, 1),
        request("/internal/quotas", { ...input, max_calls: 4 }, 1),
      ]);
      assertEquals(quotas.map((result) => result.status).sort(), [201, 409]);
      const [savedQuota] =
        await db`SELECT revision,max_calls,max_tokens,max_cost FROM llm_quotas WHERE id=${quota.id}`;
      assertEquals(savedQuota.revision, 2);
      assertEquals([3, 4].includes(savedQuota.max_calls), true);
      assertEquals(savedQuota.max_tokens, null);
      assertEquals(savedQuota.max_cost, null);
      assertEquals(
        (await request("/internal/quotas", { ...input, max_calls: 99 }, 1))
          .status,
        409,
      );
      assertEquals(
        (await request("/internal/quotas", input, 2, "school-b")).status,
        404,
      );
      assertEquals(
        (await request("/internal/quotas", { ...input, id: "absent" }, 1))
          .status,
        404,
      );
      assertEquals(
        (await request("/internal/quotas", { scope_type: "domain" }, 2)).status,
        409,
      );
    } finally {
      await db.end({ timeout: 1 });
      await admin.unsafe('DROP SCHEMA "' + schema + '" CASCADE');
      await admin.end({ timeout: 1 });
    }
  },
});
