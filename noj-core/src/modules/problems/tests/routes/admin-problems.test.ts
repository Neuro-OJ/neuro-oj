import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
} from "../../../../../tests/helper.ts";
import { resetDbForTest } from "../default-fixture.ts";

Deno.test("旧题目审核分类入口已撤除，平台管理员亦不能转 P/U", async () => {
  await resetDbForTest();
  await initRedisForTest();
  const token = await createUserToken("admin");
  const app = createApp();
  for (const method of ["GET", "POST"]) {
    const res = await jsonRequest(
      app,
      "/api/v1/admin/catalog/problems/review",
      {
        method,
        token,
        ...(method === "POST"
          ? { body: { action: "to_p", problem_ids: ["obsolete"] } }
          : {}),
      },
    );
    assertEquals(res.status, 404);
  }
});
