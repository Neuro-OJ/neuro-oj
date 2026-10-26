import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { signToken } from "../../../access/identity/index.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { createAssignment, publishAssignment } from "../../index.ts";
import { educationRouter } from "../../routes/index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test("作业学情 API：本人同步读取、教师分页、学生禁止矩阵及错误域路径", async () => {
  const f = await assignmentFixture();
  await initRedisForTest();
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  const teacher = await signToken({ sub: f.teacher, role: "user" });
  const student = await signToken({ sub: f.student, role: "user" });
  const app = createApp();
  app.route("/api/v1", educationRouter);
  const base = `/api/v1/domains/${f.school.slug}/assignments/${task.id}`;
  const own = await jsonRequest(app, `${base}/progress`, { token: student });
  assertEquals(own.status, 200);
  assertEquals(own.headers.get("Cache-Control"), "no-store");
  assertEquals((await own.json()).data.cells[0].status, "not_started");
  const matrix = await jsonRequest(app, `${base}/matrix`, { token: teacher });
  assertEquals(matrix.status, 200);
  assertEquals((await matrix.json()).data.per_page, 50);
  assertEquals(
    (await jsonRequest(app, `${base}/matrix`, { token: student })).status,
    403,
  );
  assertEquals(
    (await jsonRequest(
      app,
      `${base.replace(f.school.slug, f.other.slug)}/progress`,
      { token: student },
    )).status,
    404,
  );
  assertEquals(
    (await jsonRequest(app, `${base}/progress?scope=wrong`, { token: student }))
      .status,
    400,
  );
  assertEquals((await jsonRequest(app, `${base}/progress`)).status, 401);
  const csv = await jsonRequest(
    app,
    `${base}/matrix.csv?student_id=${f.student}`,
    { token: teacher },
  );
  assertEquals(csv.status, 200);
  assertEquals(csv.headers.get("Content-Type"), "text/csv; charset=utf-8");
  assertEquals(csv.headers.get("Cache-Control"), "no-store");
  assertEquals((await csv.text()).includes("1001 分数"), true);
  assertEquals(
    (await jsonRequest(app, `${base}/matrix.csv`, { token: student })).status,
    403,
  );
  assertEquals(
    (await jsonRequest(app, `${base}/matrix?status=invalid`, {
      token: teacher,
    })).status,
    400,
  );
});
