import { assert } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  disableTestTransactionForFile,
  resetDbForTest,
} from "../../../../shared/db/connection.ts";
import { educationNotifications } from "../../../../shared/db/schema.ts";
import {
  createAssignment,
  createAssignmentFeedback,
  createAssignmentHelp,
  publishAssignment,
} from "../../index.ts";
import { processEducationBatch } from "../../services/progress-worker.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

const url = Deno.env.get("DATABASE_URL");
// 独立事务才能复现池耗尽；外层测试事务会把错误的全局读取也绑定到同一连接。
if (url) disableTestTransactionForFile();

Deno.test({
  name:
    "教学通知 PG：单连接池内发布、反馈及求助校验复用投递事务，不等待第二条连接",
  ignore: !url,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    try {
      const f = await assignmentFixture();
      const task = await createAssignment(
        f.school.slug,
        f.classroom.id,
        f.teacher,
        f.input,
      );
      await publishAssignment(
        f.school.slug,
        task.id,
        f.teacher,
        0,
        "notice-pg-publish",
      );
      await createAssignmentFeedback(
        f.school.slug,
        task.id,
        f.teacher,
        "notice-pg-feedback",
        {
          body: "给学生的反馈",
          target_user_id: f.student,
        },
      );
      await createAssignmentHelp(
        f.school.slug,
        task.id,
        f.student,
        "notice-pg-help",
        { body: "请求教学帮助" },
      );
      for (let page = 0; page < 20; page++) {
        const events = await processEducationBatch();
        assert(events.every((event) => event.succeeded));
        if (!events.length) break;
      }
      const notifications = await f.db.select().from(educationNotifications)
        .where(eq(educationNotifications.assignment_id, task.id));
      for (const type of ["assignment", "feedback", "help"]) {
        assert(
          notifications.some((row) => row.type === type),
          `${type} 通知应完成投递`,
        );
      }
    } finally {
      await resetDbForTest();
    }
  },
});
