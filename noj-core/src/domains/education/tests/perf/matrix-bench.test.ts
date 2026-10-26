import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq, sql } from "drizzle-orm";
import { assertRejects } from "jsr:@std/assert@^1";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import { createApp } from "../../../../app.ts";
import { signToken } from "../../../identity/index.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import {
  assignmentProgress,
  classroomMemberships,
  domainMemberRoles,
  domainMemberships,
  domainProblemBindings,
  evaluationAttempts,
  problems,
  problemVersions,
  submissions,
  submissionVersionResults,
  users,
} from "../../../../shared/db/schema.ts";
import {
  createAssignment,
  exportAssignmentMatrixCsv,
  publishAssignment,
  removeClassroomMember,
  setClassroomMember,
  startEducationWorker,
  transferClassroom,
} from "../../index.ts";
import { educationRouter } from "../../routes/index.ts";
import { recomputeAssignmentProgress } from "../../services/progress-materializer.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";
import { recomputeSubmissionProjection } from "../../../submission/index.ts";

Deno.test({
  name: "教学矩阵性能：100 学生 × 50 题，50 学生分页 HTTP 读取 p95 ≤2 秒",
  ignore: Deno.env.get("NOJ_RUN_PERF") !== "1" || !Deno.env.get("DATABASE_URL"),
  async fn() {
    if (Deno.env.get("NOJ_PERF_ALLOW_EXTERNAL_DB") !== "1") {
      throw new Error("性能数据只允许写入已确认可清理的隔离数据库");
    }
    const f = await assignmentFixture(), now = new Date().toISOString();
    await initRedisForTest();
    const ids = [f.student], extraUsers = [], memberships = [];
    for (let i = 1; i < 100; i++) {
      const id = crypto.randomUUID(), membershipId = crypto.randomUUID();
      ids.push(id);
      extraUsers.push({
        id,
        username: id,
        email: `${id}@example.com`,
        created_at: now,
        updated_at: now,
      });
      memberships.push({
        id: membershipId,
        domain_id: f.school.id,
        user_id: id,
        joined_at: now,
      });
    }
    await f.db.insert(users).values(extraUsers);
    await f.db.insert(domainMemberships).values(memberships);
    await f.db.insert(domainMemberRoles).values(
      memberships.map((m) => ({
        membership_id: m.id,
        role: "member" as const,
      })),
    );
    await f.db.insert(classroomMemberships).values(
      extraUsers.map((user) => ({
        id: crypto.randomUUID(),
        domain_id: f.school.id,
        classroom_id: f.classroom.id,
        user_id: user.id,
        role: "student" as const,
        joined_at: now,
        appointed_at: now,
      })),
    );
    const bindings = [f.bindingId];
    const sources = [{
      id: f.problemId,
      versionId: f.versionId,
      bindingId: f.bindingId,
    }];
    for (let i = 1; i < 50; i++) {
      const id = crypto.randomUUID(),
        versionId = crypto.randomUUID(),
        bindingId = crypto.randomUUID();
      await f.db.insert(problems).values({
        id,
        domain_id: f.school.id,
        number: 2000 + i,
        title: `矩阵题 ${i}`,
        description: "性能夹具",
        owner_id: f.owner,
        created_at: now,
        updated_at: now,
      });
      await f.db.insert(problemVersions).values({
        id: versionId,
        problem_id: id,
        version: 1,
        content: { kind: "ai", title: `矩阵题 ${i}`, description: "性能夹具" },
        published_at: now,
      });
      await f.db.update(problems).set({ latest_version_id: versionId }).where(
        eq(problems.id, id),
      );
      await f.db.insert(domainProblemBindings).values({
        id: bindingId,
        domain_id: f.school.id,
        problem_id: id,
        kind: "owned",
        visibility: "members",
        created_by: f.owner,
        created_at: now,
        updated_at: now,
      });
      bindings.push(bindingId);
      sources.push({ id, versionId, bindingId });
    }
    const task = await createAssignment(
      f.school.slug,
      f.classroom.id,
      f.teacher,
      {
        title: "矩阵性能基线",
        items: bindings.map((binding_id) => ({
          binding_id,
          requirement: "min_score",
          minimum_score: 6000,
        })),
      },
    );
    await publishAssignment(f.school.slug, task.id, f.teacher, 0, "benchmark");
    const receivedAt = new Date().toISOString();
    const sourceRows = ids.flatMap((user_id, student) =>
      sources.map((source, problem) => ({
        user_id,
        source,
        id: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        score: (student + problem) % 101 * 100,
      }))
    );
    for (let offset = 0; offset < sourceRows.length; offset += 500) {
      const batch = sourceRows.slice(offset, offset + 500);
      await f.db.insert(submissions).values(
        batch.map((row) => ({
          id: row.id,
          domain_id: f.school.id,
          domain_problem_binding_id: row.source.bindingId,
          user_id: row.user_id,
          problem_id: row.source.id,
          language: "python",
          code: "print(0)",
          status: "finished" as const,
          submitted_version_id: row.source.versionId,
          version_origin: "known" as const,
          created_at: receivedAt,
        })),
      );
      await f.db.insert(evaluationAttempts).values(
        batch.map((row) => ({
          id: row.attemptId,
          submission_id: row.id,
          problem_id: row.source.id,
          problem_version_id: row.source.versionId,
          sequence: 0,
          source: "initial" as const,
          state: "finished" as const,
          result_kind: "graded" as const,
          score: row.score,
          accepted: row.score === 10000,
          created_at: receivedAt,
        })),
      );
      await f.db.insert(submissionVersionResults).values(
        batch.map((row) => ({
          id: crypto.randomUUID(),
          submission_id: row.id,
          problem_id: row.source.id,
          problem_version_id: row.source.versionId,
          current_attempt_id: row.attemptId,
          updated_at: receivedAt,
        })),
      );
    }
    await f.db.execute(
      sql`UPDATE submissions s SET effective_attempt_id = e.id, latest_attempt_id = e.id,
      accepted_attempt_id = CASE WHEN e.accepted THEN e.id END, is_valid = true, is_accepted = e.accepted
      FROM evaluation_attempts e WHERE e.submission_id = s.id AND s.domain_id = ${f.school.id}`,
    );
    await recomputeAssignmentProgress(task.id, ids.slice(0, 50));
    await recomputeAssignmentProgress(task.id, ids.slice(50));
    const token = await signToken({ sub: f.teacher, role: "user" });
    const app = createApp();
    app.route("/api/v1", educationRouter);
    const timings = [];
    for (let iteration = 0; iteration < 22; iteration++) {
      const page = iteration % 2 + 1, start = performance.now();
      const response = await jsonRequest(
        app,
        `/api/v1/domains/${f.school.slug}/assignments/${task.id}/matrix?page=${page}`,
        { token },
      );
      assertEquals(response.status, 200);
      const data = (await response.json()).data;
      assertEquals(data.total, 100);
      assertEquals(data.rows.length, 50);
      assertEquals(data.items.length, 50);
      assertEquals(
        data.rows.every((row: { cells: unknown[] }) => row.cells.length === 50),
        true,
      );
      assertEquals(data.updating, false);
      assertEquals(
        data.rows.every((row: { cells: Array<{ score: number | null }> }) =>
          row.cells.every((cell) => cell.score !== null)
        ),
        true,
      );
      if (iteration >= 2) timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1];
    console.log(
      "教学矩阵性能记录",
      JSON.stringify({
        students: 100,
        problems: 50,
        page_size: 50,
        samples: timings.length,
        graded_submissions: 5000,
        materialized_cells: 10000,
        p95_ms: Math.round(p95 * 100) / 100,
        max_ms: Math.round(timings.at(-1)! * 100) / 100,
        scope:
          "本地 PostgreSQL 隔离测试事务，HTTP 处理器含认证与 JSON 编解码，不含 TCP/TLS、浏览器渲染及在途重测压力",
      }),
    );
    assertEquals(p95 <= 2000, true);
    // 在相同100×50数据上完成一次正式重测，后台消费者必须采用新的尝试。
    const changed = sourceRows[0], attemptId = crypto.randomUUID();
    const progressStarted = performance.now();
    await f.db.transaction(async (tx) => {
      await tx.insert(evaluationAttempts).values({
        id: attemptId,
        submission_id: changed.id,
        problem_id: changed.source.id,
        problem_version_id: changed.source.versionId,
        sequence: 1,
        source: "rejudge",
        state: "finished",
        result_kind: "graded",
        score: 6500,
        accepted: false,
        created_at: new Date().toISOString(),
      });
      await tx.update(submissionVersionResults).set({
        current_attempt_id: attemptId,
        updated_at: new Date().toISOString(),
      }).where(eq(submissionVersionResults.submission_id, changed.id));
      await recomputeSubmissionProjection(tx, {
        kind: "submission",
        id: changed.id,
        problem_id: changed.source.id,
        contest_id: null,
        domain_problem_binding_id: changed.source.bindingId,
      });
    });
    const worker = startEducationWorker();
    try {
      const readCells = () =>
        f.db.select().from(assignmentProgress).where(and(
          eq(assignmentProgress.assignment_id, task.id),
          eq(assignmentProgress.user_id, changed.user_id),
          eq(assignmentProgress.source_submission_id, changed.id),
        ));
      let cells = await readCells();
      while (
        !cells.every((cell) => cell.source_attempt_id === attemptId) &&
        performance.now() - progressStarted < 5000
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        cells = await readCells();
      }
      assertEquals(cells.length, 2);
      assertEquals(
        cells.every((cell) =>
          cell.source_attempt_id === attemptId && cell.score === 6500 &&
          cell.status === "achieved" && !cell.accepted
        ),
        true,
      );
      const progressMs = performance.now() - progressStarted;
      assertEquals(progressMs <= 5000, true);
      console.log(
        "教学进度更新性能记录",
        JSON.stringify({
          students: 100,
          problems: 50,
          graded_submissions: 5000,
          materialized_cells: 10000,
          updated_scopes: ["on_time", "current"],
          elapsed_ms: Math.round(progressMs * 100) / 100,
          scope:
            "正式重测投影与持久事件至真实后台消费者更新，含启动及既有发布事件，不含Judge评测耗时",
        }),
      );
    } finally {
      worker.stop();
      await worker.done;
    }
    const csv = await exportAssignmentMatrixCsv(
      f.school.slug,
      task.id,
      f.teacher,
    );
    const chunks = [];
    for await (const chunk of csv) chunks.push(chunk);
    const lines = chunks.join("").split("\r\n").filter(Boolean);
    assertEquals(lines.length, 101);
    assertEquals(
      ids.every((id) =>
        lines.filter((line) => line.startsWith(`"${id}",`)).length === 1
      ),
      true,
    );
    const revocable = await exportAssignmentMatrixCsv(
      f.school.slug,
      task.id,
      f.teacher,
    );
    await revocable.next(); // 表头
    await revocable.next(); // 已授权的第一页
    await setClassroomMember(
      f.school.slug,
      f.classroom.id,
      f.owner,
      f.owner,
      1,
      { role: "coach" },
    );
    await transferClassroom(f.school.slug, f.classroom.id, f.owner, f.owner, 2);
    await removeClassroomMember(
      f.school.slug,
      f.classroom.id,
      f.owner,
      f.teacher,
      3,
    );
    await assertRejects(() => revocable.next(), NotFoundError);
  },
});
