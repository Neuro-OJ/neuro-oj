import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
} from "../../../../../tests/helper.ts";
import { updateSetting } from "../../../system/index.ts";

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
