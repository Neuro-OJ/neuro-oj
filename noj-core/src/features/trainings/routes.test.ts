import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../app.ts";
import { signToken } from "../../modules/access/identity/index.ts";
import { initRedisForTest, jsonRequest } from "../../../tests/helper.ts";
import { assignmentFixture } from "../../modules/education/tests/_assignment-fixture.ts";
import { domainTrainingsRouter } from "./routes.ts";

Deno.test("域题单 API：创建和编辑验证域及角色、revision；私有题单不向其他成员开放", async () => {
  const f = await assignmentFixture();
  await initRedisForTest();
  const owner = await signToken({ sub: f.owner, role: "user" });
  const student = await signToken({ sub: f.student, role: "user" });
  const app = createApp();
  app.route("/api/v1", domainTrainingsRouter);
  const base = `/api/v1/domains/${f.school.slug}/trainings`;
  const input = {
    title: "教师题单",
    visibility: "private",
    problems: ["1001"],
  };
  const created = await jsonRequest(app, base, {
    method: "POST",
    token: owner,
    body: input,
  });
  assertEquals(created.status, 201);
  assertEquals(created.headers.get("Cache-Control"), "no-store");
  const training = (await created.json()).data;
  assertEquals(training.domain_id, f.school.id);
  const path = `${base}/${training.id}`;
  assertEquals((await jsonRequest(app, path, { token: student })).status, 404);
  assertEquals(
    (await jsonRequest(app, path.replace(f.school.slug, f.other.slug), {
      token: owner,
    })).status,
    404,
  );
  const detail = await jsonRequest(app, path, { token: owner });
  assertEquals(detail.status, 200);
  assertEquals((await detail.json()).data.items[0].display_ref, "1001");
  // 旧实例级链接 `/trainings/<public_id>` 直接跳到域内页面，域接口须接受 public_id
  assertEquals(typeof training.public_id, "string");
  const byPublicId = await jsonRequest(app, `${base}/${training.public_id}`, {
    token: owner,
  });
  assertEquals(byPublicId.status, 200);
  assertEquals((await byPublicId.json()).data.id, training.id);
  assertEquals(
    (await jsonRequest(app, `${base}/tr-not-exist`, { token: owner })).status,
    404,
  );
  assertEquals(
    (await jsonRequest(app, base, {
      method: "POST",
      token: student,
      body: input,
    })).status,
    403,
  );
  assertEquals(
    (await jsonRequest(app, path, {
      method: "PATCH",
      token: owner,
      body: input,
    })).status,
    428,
  );
});
