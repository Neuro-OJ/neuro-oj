import { assertEquals } from "jsr:@std/assert@^1";
import { createDb } from "../src/db.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createInternalRouter } from "../src/routes/internal.ts";
import { testConfig } from "./helpers.ts";

const databaseUrl = Deno.env.get("NOJ_GATEWAY_TEST_DATABASE_URL");

Deno.test({
  name: "域数据库：空库与历史库迁移、Provider与quota跨域ID不越界",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const admin = createDb(databaseUrl!);
    try {
      for (const legacy of [false, true]) {
        const schema = "gw_domain_" + crypto.randomUUID().replaceAll("-", "");
        await admin.unsafe('CREATE SCHEMA "' + schema + '"');
        const url = new URL(databaseUrl!);
        url.searchParams.set("options", "-csearch_path=" + schema);
        const db = createDb(url.toString());
        try {
          if (legacy) {
            await db`CREATE TABLE llm_schema_migrations (id serial PRIMARY KEY,name text NOT NULL UNIQUE,applied_at text NOT NULL)`;
            for (
              const file of [
                "0000_baseline.sql",
                "0001_llm_usage_billed_tokens.sql",
                "0002_remove_byok_created_by.sql",
                "0003_remove_provider_model.sql",
                "0004_llm_usage_attempt_scope.sql",
              ]
            ) {
              await db.unsafe(
                await Deno.readTextFile(
                  new URL("../drizzle/" + file, import.meta.url),
                ),
              );
              await db`INSERT INTO llm_schema_migrations(name,applied_at) VALUES (${file},'2026-01-01')`;
            }
            await db`INSERT INTO llm_providers (id,name,base_url,encrypted_api_key,created_at,updated_at)
              VALUES ('old-provider','legacy','https://api.openai.com','cipher','2026-01-01','2026-01-01')`;
            await db`INSERT INTO llm_usage (id,submission_id,problem_id,user_id,provider_id,model,request_messages,prompt_hash,created_at)
              VALUES ('old-usage','old-sub','source','student','old-provider','old-model','[]','hash','2026-01-01')`;
            await db`INSERT INTO llm_quotas(id,scope_type,scope_id,window_type,max_calls,max_tokens,max_cost,created_at,updated_at)
              VALUES ('old-global','global','','day',11,22,33,'2026-01-01','2026-01-01'),
                     ('old-user','user','student','day',4,5,6,'2026-01-01','2026-01-01')`;
          }
          await runMigrations(url.toString());
          await runMigrations(url.toString());
          if (legacy) {
            const [row] =
              await db`SELECT domain_id,encrypted_api_key FROM llm_providers WHERE id='old-provider'`;
            assertEquals(row.domain_id, "00000000-0000-4000-8000-000000000001");
            assertEquals(row.encrypted_api_key, "cipher");
            const [usage] =
              await db`SELECT domain_id,model FROM llm_usage WHERE id='old-usage'`;
            assertEquals(
              usage.domain_id,
              "00000000-0000-4000-8000-000000000001",
            );
            assertEquals(usage.model, "old-model");
            const migratedQuotas =
              await db`SELECT id,domain_id,max_calls FROM llm_quotas ORDER BY id`;
            assertEquals(migratedQuotas.map((quota) => ({ ...quota })), [
              { id: "old-global", domain_id: "", max_calls: 11 },
              {
                id: "old-user",
                domain_id: "00000000-0000-4000-8000-000000000001",
                max_calls: 4,
              },
            ]);
          }
          const app = createInternalRouter({ config: testConfig, db });
          const request = (
            path: string,
            domainId: string,
            method = "GET",
            body?: unknown,
          ) =>
            app.request(path, {
              method,
              headers: {
                authorization: "Bearer " + testConfig.serviceToken,
                "content-type": "application/json",
                "X-Noj-Domain-Id": domainId,
                ...(method === "GET" ? {} : {
                  "If-Match": path.endsWith("/providers") ||
                      path.endsWith("/quotas") &&
                        !(body as { id?: string })?.id
                    ? "0"
                    : "1",
                }),
              },
              body: body === undefined ? undefined : JSON.stringify(body),
            });
          const created = await request(
            "/internal/providers",
            "school-a",
            "POST",
            {
              name: "private-provider",
              base_url: "https://api.openai.com",
              api_key: "sk-private-key",
            },
          );
          assertEquals(created.status, 201);
          const provider = (await created.json()).data;
          assertEquals(provider.domain_id, "school-a");
          assertEquals(
            (await request("/internal/providers/" + provider.id, "school-b"))
              .status,
            404,
          );
          assertEquals(
            (await request(
              "/internal/providers/" + provider.id,
              "school-b",
              "PUT",
              { name: "stolen" },
            )).status,
            404,
          );
          assertEquals(
            (await request("/internal/providers", "school-b")).status,
            200,
          );
          assertEquals(
            (await (await request("/internal/providers", "school-b")).json())
              .data,
            [],
          );
          const quota = await request("/internal/quotas", "school-a", "POST", {
            scope_type: "domain",
            max_calls: 1,
            max_tokens: null,
            max_cost: null,
          });
          assertEquals(quota.status, 201);
          const quotaId = (await quota.json()).data.id;
          assertEquals(
            (await request("/internal/quotas", "school-b", "POST", {
              id: quotaId,
              scope_type: "domain",
              max_calls: 99,
            })).status,
            404,
          );
          const [stored] =
            await db`SELECT domain_id,max_calls,max_tokens FROM llm_quotas WHERE id=${quotaId}`;
          assertEquals(stored.domain_id, "school-a");
          assertEquals(stored.max_calls, 1);
          assertEquals(stored.max_tokens, null);
          assertEquals(
            (await request("/internal/quotas", "school-b")).status,
            200,
          );
          assertEquals(
            (await (await request("/internal/quotas", "school-b")).json()).data,
            [],
          );
          const historyUsage =
            await (await request("/internal/usage", "school-b")).json();
          assertEquals(historyUsage.data, []);
          const instanceQuotaRequest = (method: string, body?: unknown) =>
            app.request("/internal/quotas", {
              method,
              headers: {
                authorization: "Bearer " + testConfig.serviceToken,
                "content-type": "application/json",
                "X-Noj-Domain-Id": "school-a",
                "X-Noj-Instance-Quota": "1",
                ...(method === "GET" ? {} : { "If-Match": "0" }),
              },
              body: body === undefined ? undefined : JSON.stringify(body),
            });
          assertEquals(
            (await request("/internal/quotas", "school-a", "POST", {
              scope_type: "global",
              max_calls: 5,
            })).status,
            403,
          );
          const createdInstance = await instanceQuotaRequest("POST", {
            scope_type: "global",
            max_calls: 5,
          });
          assertEquals(createdInstance.status, 201);
          const instanceId = (await createdInstance.json()).data.id;
          const instanceQuotas =
            (await (await instanceQuotaRequest("GET")).json()).data;
          assertEquals(
            instanceQuotas.every((entry: { domain_id: string }) =>
              entry.domain_id === ""
            ),
            true,
          );
          assertEquals(
            instanceQuotas.some((entry: { id: string }) =>
              entry.id === instanceId
            ),
            true,
          );
          const domainQuotas =
            (await (await request("/internal/quotas", "school-a")).json()).data;
          assertEquals(
            domainQuotas.every((entry: { domain_id: string }) =>
              entry.domain_id === "school-a"
            ),
            true,
          );
          assertEquals(
            (await request(
              "/internal/providers/" + provider.id,
              "school-a",
              "DELETE",
            )).status,
            204,
          );
          const [retained] =
            await db`SELECT enabled FROM llm_providers WHERE id=${provider.id}`;
          assertEquals(retained.enabled, false);
        } finally {
          await db.end();
          await admin.unsafe('DROP SCHEMA "' + schema + '" CASCADE');
        }
      }
    } finally {
      await admin.end();
    }
  },
});
