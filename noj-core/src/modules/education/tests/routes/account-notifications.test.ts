import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { accountNotifications, domains } from "../../../../shared/db/schema.ts";
import { signToken } from "../../../access/identity/index.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { createAssignment, publishAssignment } from "../../index.ts";
import { processEducationBatch } from "../../services/progress-worker.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test("统一通知：教学与账号消息共用分页、未读和已读，失效域不计数且无法点击", async () => {
  const f = await assignmentFixture();
  await initRedisForTest();
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  for (let i = 0; i < 20; i++) {
    if (!(await processEducationBatch()).length) break;
  }
  const follow = crypto.randomUUID(), unrelated = crypto.randomUUID();
  await f.db.insert(accountNotifications).values([
    {
      id: follow,
      recipient_id: f.student,
      actor_id: f.teacher,
      type: "follow",
      created_at: new Date().toISOString(),
    },
    {
      id: unrelated,
      recipient_id: f.teacher,
      actor_id: f.student,
      type: "follow",
      created_at: new Date().toISOString(),
    },
  ]);
  const token = await signToken({ sub: f.student, role: "user" });
  const app = createApp(), base = "/api/v1/notifications";
  const list = async (query = "") =>
    (await jsonRequest(app, base + query, { token })).json();
  const inbox = await list("?per_page=1");
  assertEquals(inbox.total, 2);
  assertEquals(inbox.unread_count, 2);
  assertEquals(inbox.data.length, 1);
  const domain = await list(`?domain_id=${f.school.id}`);
  assertEquals(domain.total, 1);
  const teaching = domain.data[0].notification.id;
  assertEquals(
    (await jsonRequest(app, `${base}/${unrelated}`, { token })).status,
    404,
  );
  await f.db.update(domains).set({ status: "suspended" }).where(
    eq(domains.id, f.school.id),
  );
  const hidden = await list();
  assertEquals(hidden.total, 1);
  assertEquals(hidden.unread_count, 1);
  for (const suffix of ["", "/read"]) {
    assertEquals(
      (await jsonRequest(app, `${base}/${teaching}${suffix}`, {
        token,
        method: suffix ? "POST" : "GET",
      })).status,
      404,
    );
  }
  assertEquals(
    (await jsonRequest(app, `${base}/read`, { token, method: "POST" })).status,
    204,
  );
  assertEquals((await list()).unread_count, 0);
  await f.db.update(domains).set({ status: "active" }).where(
    eq(domains.id, f.school.id),
  );
  assertEquals((await list()).unread_count, 1);
  assertEquals(
    (await jsonRequest(app, `${base}/${teaching}/read`, {
      token,
      method: "POST",
    })).status,
    204,
  );
  assertEquals((await list()).unread_count, 0);
});
