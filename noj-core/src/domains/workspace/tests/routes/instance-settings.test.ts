import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
} from "../../../../../tests/helper.ts";

await resetDbForTest();
await initRedisForTest();

Deno.test("实例分组设置：原子保存、失败回滚、版本冲突及角色隔离", async () => {
  await resetDbForTest();
  const app = createApp();
  const admin = await createUserToken("admin"), user = await createUserToken();
  const path = "/api/v1/admin/instance/settings/creation";
  assertEquals((await jsonRequest(app, path, { token: user })).status, 403);
  const { data: initial } =
    await (await jsonRequest(app, path, { token: admin })).json();
  const change = (values: unknown, revision?: string) =>
    jsonRequest(app, path, {
      method: "PATCH",
      token: admin,
      body: { values },
      headers: revision ? { "If-Match": revision } : {},
    });
  assertEquals((await change(initial.values)).status, 428);
  assertEquals(
    (await change(
      { domain_creation_policy: "open", domain_creation_limit: -1 },
      initial.revision,
    )).status,
    400,
  );
  const { data: unchanged } =
    await (await jsonRequest(app, path, { token: admin })).json();
  assertEquals(unchanged, initial);
  const saved = await change({
    domain_creation_policy: "approval",
    domain_creation_limit: 8,
  }, initial.revision);
  assertEquals(saved.status, 200);
  const { data: current } = await saved.json();
  assertNotEquals(current.revision, initial.revision);
  assertEquals(current.values.domain_creation_limit, 8);
  assertEquals((await change(initial.values, initial.revision)).status, 409);
  assertEquals(
    (await change(
      { ...current.values, instance_access: "public" },
      current.revision,
    )).status,
    400,
  );
});
