import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { AppError } from "../../../../shared/base/errors.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { systemSettings } from "../../../../shared/db/schema.ts";
import { internalLlmPolicyRouter } from "../../routes/internal-llm-policy.ts";
import {
  _resetEnvSnapshotForTest,
  snapshotEnv,
} from "../../services/env-snapshot.ts";
import { updateSetting } from "../../index.ts";

Deno.test({
  name:
    "内部 LLM 上限：仅服务凭据可读，政策变化立即读取持久值，非法上限拒绝写入",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const previous = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
    Deno.env.set(
      "NOJ_LLM_SERVICE_TOKEN",
      "test-internal-policy-secret-0123456789",
    );
    _resetEnvSnapshotForTest();
    snapshotEnv();
    const app = new Hono();
    app.onError((error, c) =>
      error instanceof AppError
        ? c.json({ code: error.code }, error.statusCode as 401)
        : c.json({ code: "internal" }, 500)
    );
    app.route("/api/v1", internalLlmPolicyRouter);
    const path = "/api/v1/internal/llm/quota-caps";
    try {
      assertEquals((await app.request(path)).status, 401);
      assertEquals(
        (await app.request(path, { headers: { Authorization: "Bearer bad" } }))
          .status,
        401,
      );
      const headers = {
        Authorization: "Bearer test-internal-policy-secret-0123456789",
      };
      const initial = await app.request(path, { headers });
      assertEquals(initial.status, 200);
      assertEquals(initial.headers.get("Cache-Control"), "no-store");
      const unlimited = {
        day: { max_calls: null, max_tokens: null, max_cost: null },
        month: { max_calls: null, max_tokens: null, max_cost: null },
      };
      assertEquals(await initial.json(), { data: unlimited });
      const caps = {
        ...unlimited,
        day: { max_calls: 2, max_tokens: 100, max_cost: 5 },
      };
      await updateSetting("domain_llm_quota_caps", JSON.stringify(caps), "0");
      assertEquals(await (await app.request(path, { headers })).json(), {
        data: caps,
      });
      caps.day.max_calls = 1;
      // 直接更改持久值模拟其他副本修改，不能依赖当前进程配置通知到达。
      await getDb().update(systemSettings).set({
        value: JSON.stringify(JSON.stringify(caps)),
      }).where(eq(systemSettings.key, "domain_llm_quota_caps"));
      assertEquals(await (await app.request(path, { headers })).json(), {
        data: caps,
      });
      for (
        const invalid of [{ ...caps, day: { ...caps.day, max_tokens: -1 } }, {
          ...caps,
          month: {},
        }, { day: caps.day }]
      ) {
        let rejected = false;
        try {
          await updateSetting(
            "domain_llm_quota_caps",
            JSON.stringify(invalid),
            "0",
          );
        } catch {
          rejected = true;
        }
        assertEquals(rejected, true);
      }
    } finally {
      if (previous === undefined) Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
      else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", previous);
      _resetEnvSnapshotForTest();
      snapshotEnv();
    }
  },
});
