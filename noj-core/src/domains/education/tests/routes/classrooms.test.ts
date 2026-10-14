import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { signToken } from "../../../identity/index.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { educationRouter } from "../../routes/index.ts";
import { educationFixture } from "../_fixtures.ts";

Deno.test("班级 API：创建编辑、身份隔离、前置条件和缓存范围", async () => {
  const f = await educationFixture();
  await initRedisForTest();
  const token = await signToken({ sub: f.teacher, role: "user" });
  const student = await signToken({ sub: f.student, role: "user" });
  const app = createApp();
  app.route("/api/v1", educationRouter);
  app.get("/api/v1/education-cache-fixture", () =>
    new Response("ok", {
      headers: { "Cache-Control": "public, max-age=60" },
    }));
  const base = `/api/v1/domains/${f.school.slug}/classrooms`;
  const created = await jsonRequest(app, base, {
    token,
    method: "POST",
    body: { name: "API 二班" },
  });
  assertEquals(created.status, 201);
  const body = await created.json();
  const path = `${base}/${body.data.id}`;
  const read = await jsonRequest(app, path, { token });
  assertEquals(read.status, 200);
  assertEquals(read.headers.get("cache-control"), "no-store");
  assertEquals(
    (await jsonRequest(app, path, {
      token,
      method: "PATCH",
      body: { name: "缺少 revision" },
    })).status,
    428,
  );
  const edited = await jsonRequest(app, path, {
    token,
    method: "PATCH",
    headers: { "If-Match": "0" },
    body: { name: "改名" },
  });
  assertEquals(edited.status, 200);
  assertEquals(
    (await jsonRequest(app, path, {
      token,
      method: "PATCH",
      headers: { "If-Match": "0" },
      body: { name: "覆盖" },
    })).status,
    409,
  );
  assertEquals(
    (await jsonRequest(app, path.replace(f.school.slug, f.other.slug), {
      token,
    })).status,
    404,
  );
  assertEquals((await jsonRequest(app, path, { token: student })).status, 404);
  assertEquals(
    (await jsonRequest(app, base, { token, method: "POST", body: null }))
      .status,
    400,
  );
  // 新模块中间件不能改变其他接口的授权或缓存策略。
  const unrelated = await jsonRequest(app, "/api/v1/education-cache-fixture", {
    token,
  });
  assertEquals(unrelated.status, 200);
  assertEquals(unrelated.headers.get("Cache-Control"), "public, max-age=60");
});
