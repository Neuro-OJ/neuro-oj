import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  accountNotifications,
  educationNotificationEmails,
} from "../../../../shared/db/schema.ts";
import { removeDomainMember } from "../../../access/workspace/index.ts";
import {
  createAssignment,
  createAssignmentFeedback,
  publishAssignment,
} from "../../index.ts";
import { processEducationBatch } from "../../services/progress-worker.ts";
import {
  claimEducationEmails,
  educationEmailContent,
  processEducationEmail,
  processEducationEmailBatch,
} from "../../services/notification-email.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

async function fixture() {
  const f = await assignmentFixture();
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "mail-publish");
  for (let i = 0; i < 10; i++) {
    if (!(await processEducationBatch()).length) break;
  }
  await f.db.delete(educationNotificationEmails);
  await f.db.delete(accountNotifications);
  await createAssignmentFeedback(
    f.school.slug,
    task.id,
    f.teacher,
    "mail-feedback",
    { body: "private feedback not emailed", target_user_id: f.student },
  );
  for (let i = 0; i < 10; i++) {
    if (!(await processEducationBatch()).length) break;
  }
  return { ...f, task };
}

Deno.test("教学邮件：领取持久化、失败重试重新授权、过期租约回收及已完成不重发", async () => {
  const f = await fixture();
  const failed = await processEducationEmailBatch(
    20,
    () => Promise.reject(new Error("sensitive vendor detail")),
  );
  assertEquals(failed.length, 1);
  assertEquals(failed[0].succeeded, false);
  const [retry] = await f.db.select().from(educationNotificationEmails);
  assertEquals(retry.attempts, 1);
  assertEquals(retry.last_error, "Error");
  assertEquals(retry.state, "pending");
  await f.db.update(educationNotificationEmails).set({
    available_at: new Date(Date.now() - 1000).toISOString(),
  });
  const [claimed] = await claimEducationEmails();
  assertEquals((await claimEducationEmails()).length, 0);
  await f.db.update(educationNotificationEmails).set({
    leased_until: new Date(Date.now() - 1000).toISOString(),
  });
  const [recovered] = await claimEducationEmails();
  assert(claimed.lease_token !== recovered.lease_token);
  let sent = 0;
  const send = (_email: string, _subject: string, html: string) => {
    sent++;
    assert(!html.includes("private feedback"));
    return Promise.resolve(true);
  };
  assertEquals(await processEducationEmail(claimed, send), false);
  assertEquals(await processEducationEmail(recovered, send), true);
  assertEquals(await processEducationEmail(recovered, send), false);
  assertEquals(sent, 1);
  assertEquals(
    (await f.db.select().from(educationNotificationEmails))[0].state,
    "sent",
  );
});

Deno.test("教学邮件：排队后移除成员持久跳过，发送前不恢复私有资源", async () => {
  const f = await fixture();
  const [claimed] = await claimEducationEmails();
  await removeDomainMember(f.school.slug, f.owner, f.student);
  let sent = 0;
  assertEquals(
    await processEducationEmail(claimed, () => {
      sent++;
      return Promise.resolve(true);
    }),
    true,
  );
  assertEquals(sent, 0);
  const [row] = await f.db.select().from(educationNotificationEmails);
  assertEquals(row.state, "skipped");
  assertEquals(row.last_error, "revoked");
});

Deno.test("教学邮件：关闭邮件Provider的false结果持久跳过，不产生无限失败重试", async () => {
  const f = await fixture();
  const [claimed] = await claimEducationEmails();
  assertEquals(
    await processEducationEmail(claimed, () => Promise.resolve(false)),
    true,
  );
  const [row] = await f.db.select().from(educationNotificationEmails);
  assertEquals(row.state, "skipped");
  assertEquals(row.last_error, "disabled");
  assertEquals((await claimEducationEmails()).length, 0);
});

Deno.test("教学邮件：固定正文仅提供定位，不从事件或资源带入私人标题、答案或成绩", () => {
  const previous = Deno.env.get("APP_URL");
  Deno.env.set("APP_URL", "https://noj.example/");
  try {
    const message = educationEmailContent("school", "assignment-id");
    assert(
      message.html.includes(
        "https://noj.example/d/school/assignments/assignment-id",
      ),
    );
    assertEquals(message.subject, "Neuro OJ 教学通知");
  } finally {
    if (previous === undefined) Deno.env.delete("APP_URL");
    else Deno.env.set("APP_URL", previous);
  }
});
