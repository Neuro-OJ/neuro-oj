import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { systemSettings } from "../../../../shared/db/schema.ts";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
} from "../../../../../tests/helper.ts";
import { refreshSettingsCache, updateSetting } from "../../../system/index.ts";
import { unlimitedDomainLimits } from "../../../../shared/workspace/resource-policy.ts";

await resetDbForTest();
await initRedisForTest();

Deno.test({
  name: "工作空间 HTTP：跨域拒绝、缺失 revision、私有实例旧入口统一门控",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const admin = await createUserToken("admin");
    const user = await createUserToken("user");
    const app = createApp();
    const created = await jsonRequest(app, "/api/v1/domains", {
      method: "POST",
      token: admin,
      body: { slug: "http-school", name: "学校", preset: "education" },
    });
    assertEquals(created.status, 201);
    const denied = await jsonRequest(app, "/api/v1/domains/http-school", {
      token: user,
    });
    assertEquals(denied.status, 404);
    assertEquals(
      (await jsonRequest(app, "/api/v1/domains/http-school", {
        method: "PATCH",
        token: admin,
        body: { name: "变更" },
      })).status,
      428,
    );
    assertEquals(
      (await jsonRequest(app, "/api/v1/domains/http-school", {
        method: "PATCH",
        token: admin,
        headers: { "If-Match": "0" },
        body: { name: "变更" },
      })).status,
      200,
    );
    await updateSetting("instance_access", "authenticated", "0");
    assertEquals((await jsonRequest(app, "/api/v1/problems")).status, 401);
    assertEquals((await jsonRequest(app, "/api/v1/instance")).status, 200);
    assertEquals(
      (await jsonRequest(app, "/api/v1/auth/register-status")).status,
      200,
    );
  },
});

Deno.test({
  name: "域配额 HTTP：错误域拒绝、If-Match 前置条件及配置 revision 冲突",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const admin = await createUserToken("admin");
    const user = await createUserToken("user");
    const app = createApp();
    await jsonRequest(app, "/api/v1/domains", {
      method: "POST",
      token: admin,
      body: { slug: "http-limits", name: "学校", preset: "education" },
    });
    const path = "/api/v1/domains/http-limits/limits";
    assertEquals((await jsonRequest(app, path, { token: user })).status, 404);
    assertEquals((await jsonRequest(app, path)).status, 401);
    const limits = { ...unlimitedDomainLimits(), members: 10 };
    assertEquals(
      (await jsonRequest(app, path, {
        method: "PATCH",
        token: admin,
        body: limits,
      })).status,
      428,
    );
    assertEquals(
      (await jsonRequest(app, path, {
        method: "PATCH",
        token: admin,
        headers: { "If-Match": "0" },
        body: limits,
      })).status,
      200,
    );
    const current = await jsonRequest(app, path, { token: admin });
    assertEquals(current.status, 200);
    const { data } = await current.json();
    assertEquals(data.revision, 1);
    assertEquals(data.effective.members, 10);
    assertEquals(
      (await jsonRequest(app, path, {
        method: "PATCH",
        token: admin,
        headers: { "If-Match": "0" },
        body: limits,
      })).status,
      409,
    );
    assertEquals(
      (await jsonRequest(app, path, {
        method: "PATCH",
        token: admin,
        headers: { "If-Match": "1" },
        body: { ...limits, members: -1 },
      })).status,
      400,
    );
    await getDb().insert(systemSettings).values({
      key: "domain_limit_caps",
      value: JSON.stringify(
        JSON.stringify({ ...unlimitedDomainLimits(), members: -1 }),
      ),
      updated_at: new Date().toISOString(),
      updated_by: "0",
    });
    await refreshSettingsCache("domain_limit_caps");
    assertEquals((await jsonRequest(app, path, { token: admin })).status, 503);
    assertEquals(
      (await jsonRequest(app, "/api/v1/admin/system/settings", {
        token: admin,
      }))
        .status,
      200,
    );
    await updateSetting(
      "domain_limit_caps",
      JSON.stringify(unlimitedDomainLimits()),
      "0",
    );
    assertEquals((await jsonRequest(app, path, { token: admin })).status, 200);
  },
});
