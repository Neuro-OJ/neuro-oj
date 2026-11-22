import { assertRejects } from "jsr:@std/assert@^1";
import {
  assignmentFeedback,
  assignmentHelpRequests,
} from "../../../../shared/db/schema.ts";
import { createAssignment, publishAssignment } from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test("教学互动数据库：跨域任务、非目标反馈和不属于任务的题目均被复合约束拒绝", async () => {
  const f = await assignmentFixture(), now = new Date().toISOString();
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  const base = {
    id: crypto.randomUUID(),
    domain_id: f.school.id,
    assignment_id: task.id,
    author_id: f.teacher,
    body: "反馈",
    created_at: now,
    updated_at: now,
  };
  await assertRejects(
    () =>
      f.db.transaction((tx) =>
        tx.insert(assignmentFeedback).values({ ...base, domain_id: f.other.id })
      ),
    Error,
  );
  await assertRejects(
    () =>
      f.db.transaction((tx) =>
        tx.insert(assignmentFeedback).values({
          ...base,
          target_user_id: f.teacher,
        })
      ),
    Error,
  );
  await assertRejects(
    () =>
      f.db.transaction((tx) =>
        tx.insert(assignmentHelpRequests).values({
          id: crypto.randomUUID(),
          domain_id: f.school.id,
          assignment_id: task.id,
          user_id: f.student,
          item_id: crypto.randomUUID(),
          body: "错误题目",
          created_at: now,
          updated_at: now,
        })
      ),
    Error,
  );
});
