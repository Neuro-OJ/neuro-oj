import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  assignmentHelpRequests,
  assignmentItems,
  submissions,
} from "../../../../shared/db/schema.ts";
import { deleteSubmission } from "../../../submission/index.ts";
import {
  createAssignment,
  createAssignmentHelp,
  getAssignmentHelp,
  listAssignmentHelp,
  publishAssignment,
  removeClassroomMember,
  replyAssignmentHelp,
  setAssignmentHelpState,
  setClassroomMember,
} from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

async function fixture() {
  const f = await assignmentFixture();
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    1,
    {},
  );
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  return { ...f, task };
}

Deno.test("作业求助：只关联本人同域提交，目录与回复不向同学泄露", async () => {
  const f = await fixture(),
    sourceId = crypto.randomUUID(),
    now = new Date().toISOString();
  await f.db.insert(submissions).values({
    id: sourceId,
    domain_id: f.school.id,
    domain_problem_binding_id: f.bindingId,
    user_id: f.student,
    problem_id: f.problemId,
    code: "原代码",
    status: "finished",
    language: "python",
    submitted_version_id: f.versionId,
    version_origin: "known",
    created_at: now,
  });
  const help = await createAssignmentHelp(
    f.school.slug,
    f.task.id,
    f.student,
    "linked",
    { body: "需要帮助", submission: { id: sourceId, kind: "submission" } },
  );
  assertEquals(help.item_id, (await f.db.select().from(assignmentItems))[0].id);
  assertEquals(
    await createAssignmentHelp(f.school.slug, f.task.id, f.student, "linked", {
      body: "需要帮助",
      submission: { id: sourceId, kind: "submission" },
    }),
    help,
  );
  await assertRejects(
    () =>
      createAssignmentHelp(
        f.school.slug,
        f.task.id,
        f.assistant,
        "other-code",
        { body: "他人提交", submission: { id: sourceId, kind: "submission" } },
      ),
    NotFoundError,
  );
  await createAssignmentHelp(
    f.school.slug,
    f.task.id,
    f.assistant,
    "other-help",
    { body: "同学的问题" },
  );
  assertEquals(
    (await listAssignmentHelp(f.school.slug, f.task.id, f.student)).total,
    1,
  );
  assertEquals(
    (await listAssignmentHelp(f.school.slug, f.task.id, f.teacher)).total,
    2,
  );
  await assertRejects(
    () => getAssignmentHelp(f.school.slug, f.task.id, help.id, f.assistant),
    NotFoundError,
  );
  await assertRejects(
    () => getAssignmentHelp(f.other.slug, f.task.id, help.id, f.owner),
    NotFoundError,
  );
  await deleteSubmission(sourceId);
  assertEquals(
    (await getAssignmentHelp(f.school.slug, f.task.id, help.id, f.student))
      .submission_id,
    null,
  );
  assertEquals(
    (await getAssignmentHelp(f.school.slug, f.task.id, help.id, f.student))
      .body,
    "需要帮助",
  );
});

Deno.test("作业求助：域角色任命控制读取、幂等回复及状态前置版本，学生追问重新打开", async () => {
  const f = await fixture();
  const help = await createAssignmentHelp(
    f.school.slug,
    f.task.id,
    f.student,
    "new",
    { body: "如何调试" },
  );
  await assertRejects(
    () => getAssignmentHelp(f.school.slug, f.task.id, help.id, f.assistant),
    NotFoundError,
  );
  await setMemberRole(f.school.slug, f.owner, f.assistant, "coach");
  const reply = await replyAssignmentHelp(
    f.school.slug,
    f.task.id,
    help.id,
    f.assistant,
    "reply",
    { body: "检查循环边界", resolve: true },
  );
  assertEquals(
    await replyAssignmentHelp(
      f.school.slug,
      f.task.id,
      help.id,
      f.assistant,
      "reply",
      { body: "检查循环边界", resolve: true },
    ),
    reply,
  );
  let detail = await getAssignmentHelp(
    f.school.slug,
    f.task.id,
    help.id,
    f.student,
  );
  assertEquals(detail.state, "resolved");
  assertEquals(detail.replies.length, 1);
  await assertRejects(
    () =>
      setAssignmentHelpState(
        f.school.slug,
        f.task.id,
        help.id,
        f.student,
        detail.revision,
        "resolved",
      ),
    ForbiddenError,
  );
  await assertRejects(
    () =>
      setAssignmentHelpState(
        f.school.slug,
        f.task.id,
        help.id,
        f.assistant,
        null,
        "open",
      ),
    AppError,
  );
  await replyAssignmentHelp(
    f.school.slug,
    f.task.id,
    help.id,
    f.student,
    "followup",
    { body: "还有一个问题" },
  );
  detail = await getAssignmentHelp(
    f.school.slug,
    f.task.id,
    help.id,
    f.teacher,
  );
  assertEquals(detail.state, "open");
  assertEquals(detail.handled_by, null);
  await assertRejects(
    () =>
      setAssignmentHelpState(
        f.school.slug,
        f.task.id,
        help.id,
        f.assistant,
        0,
        "resolved",
      ),
    AppError,
  );
  assertEquals(
    (await setAssignmentHelpState(
      f.school.slug,
      f.task.id,
      help.id,
      f.assistant,
      detail.revision,
      "resolved",
    )).state,
    "resolved",
  );
});

Deno.test("作业求助：学生离班后保留旧讨论，但不能继续新的班级互动", async () => {
  const f = await fixture();
  const help = await createAssignmentHelp(
    f.school.slug,
    f.task.id,
    f.student,
    "new",
    { body: "历史问题" },
  );
  await replyAssignmentHelp(
    f.school.slug,
    f.task.id,
    help.id,
    f.teacher,
    "teacher",
    { body: "已有解释" },
  );
  await removeClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    2,
  );
  assertEquals(
    (await getAssignmentHelp(f.school.slug, f.task.id, help.id, f.student))
      .replies[0].body,
    "已有解释",
  );
  await assertRejects(
    () =>
      replyAssignmentHelp(
        f.school.slug,
        f.task.id,
        help.id,
        f.student,
        "after-leave",
        { body: "新问题" },
      ),
    NotFoundError,
  );
  assertEquals(
    (await f.db.select().from(assignmentHelpRequests).where(
      eq(assignmentHelpRequests.id, help.id),
    )).length,
    1,
  );
});
import { setMemberRole } from "../../../workspace/index.ts";
