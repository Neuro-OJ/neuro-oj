import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import {
  annotationMessages,
  annotationThreads,
  auditLogs,
  communityPosts,
  domainProblemBindings,
  roles,
  submissionAnnotations,
  submissions,
  userRoles,
} from "../../../shared/db/schema.ts";
import { assignmentFixture } from "../../education/tests/_assignment-fixture.ts";
import { setMemberRole } from "../../workspace/index.ts";
import {
  annotationInbox,
  createAnnotation,
  getAnnotation,
  getAnnotationOriginal,
  listAnnotations,
  markAnnotationRead,
  replyAnnotation,
  shareAnnotation,
  updateAnnotationMessage,
  updateAnnotationThread,
} from "../services/threads.ts";
import { getAnnotationSource } from "../services/sources.ts";
import type { AnnotationTarget } from "../../../shared/annotation-types.ts";
import { deleteSubmission } from "../../submission/index.ts";
import {
  createSubmissionAnnotation,
  listSubmissionAnnotations,
  updateSubmissionAnnotation,
} from "../../education/index.ts";

async function fixture() {
  const f = await assignmentFixture(), id = crypto.randomUUID();
  await f.db.insert(submissions).values({
    id,
    domain_id: f.school.id,
    domain_problem_binding_id: f.bindingId,
    user_id: f.student,
    problem_id: f.problemId,
    language: "python",
    code: "a = 1\nprint(a)\n",
    file_name: "main.py",
    submitted_version_id: f.versionId,
    version_origin: "known",
    created_at: new Date().toISOString(),
  });
  const target: AnnotationTarget = {
    kind: "problem",
    reference: "1001",
    version_id: f.versionId,
    field: "description",
  };
  const source = await getAnnotationSource(f.school.slug, f.student, target);
  const input = {
    target,
    content_hash: source.content_hash,
    anchor: { block_id: source.blocks[0]!.id, start: 0, end: 2 },
    body: "这句话如何理解？",
  };
  return { ...f, id, target, source, note: input };
}

Deno.test("全局批注：旧行批注保留 ID，仅迁移一次，旧新入口共同编辑且撤回不会复活", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  const target: AnnotationTarget = {
    kind: "submission",
    submission_id: f.id,
    file_name: "main.py",
  };
  const source = await getAnnotationSource(f.school.slug, f.teacher, target);
  await f.db.insert(submissionAnnotations).values({
    id,
    domain_id: f.school.id,
    classroom_id: f.classroom.id,
    submission_id: f.id,
    user_id: f.student,
    author_id: f.teacher,
    file_name: "main.py",
    source_hash: source.content_hash,
    start_line: 2,
    end_line: 2,
    body: "旧批注正文",
    revision: 2,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  assertEquals(
    (await listAnnotations(f.school.slug, f.student)).data.length,
    0,
  );
  const migrated = await getAnnotation(f.school.slug, f.student, id);
  assertEquals(migrated.id, id);
  assertEquals(migrated.anchor.quote, "print(a)");
  assertEquals(migrated.messages[0]!.body, "旧批注正文");
  await updateSubmissionAnnotation(
    f.school.slug,
    f.classroom.id,
    f.id,
    id,
    f.teacher,
    2,
    { body: "统一后的正文" },
  );
  assertEquals(
    (await getAnnotation(f.school.slug, f.student, id)).messages[0]!.body,
    "统一后的正文",
  );
  assertEquals(
    (await listSubmissionAnnotations(
      f.school.slug,
      f.classroom.id,
      f.id,
      f.student,
    )).data[0]!.body,
    "统一后的正文",
  );
  assertEquals(
    (await f.db.select().from(annotationThreads).where(
      eq(annotationThreads.id, id),
    )).length,
    1,
  );
  await updateSubmissionAnnotation(
    f.school.slug,
    f.classroom.id,
    f.id,
    id,
    f.teacher,
    3,
    { withdraw: true },
  );
  await assertRejects(
    () => getAnnotation(f.school.slug, f.student, id),
    NotFoundError,
  );
  assertEquals(
    (await listAnnotations(f.school.slug, f.student, { target, shared: true }))
      .data.length,
    0,
  );
});

Deno.test("全局批注：旧写入口只写统一表，课堂外全局列表可读，其他学生无权查看", async () => {
  const f = await fixture(),
    target: AnnotationTarget = {
      kind: "submission",
      submission_id: f.id,
      file_name: "main.py",
    };
  const source = await getAnnotationSource(f.school.slug, f.teacher, target);
  const note = await createSubmissionAnnotation(
    f.school.slug,
    f.classroom.id,
    f.id,
    f.teacher,
    "legacy-new",
    {
      file_name: "main.py",
      source_hash: source.content_hash,
      start_line: 1,
      end_line: 1,
      body: "保留兼容入口",
    },
  );
  assertEquals((await f.db.select().from(submissionAnnotations)).length, 0);
  assertEquals(
    (await getAnnotation(f.school.slug, f.student, note.id)).messages[0]!.body,
    "保留兼容入口",
  );
  await assertRejects(
    () => getAnnotation(f.school.slug, f.assistant, note.id),
    NotFoundError,
  );
});

Deno.test("全局批注：默认仅自己，owner 和教练无普通读取旁路，默认列表不含共享批注", async () => {
  const f = await fixture(),
    note = await createAnnotation(f.school.slug, f.student, "note", f.note);
  assertEquals(note.visibility, "private");
  assertEquals(note.anchor.quote, "题面");
  await assertRejects(
    () => getAnnotation(f.school.slug, f.teacher, note.id),
    NotFoundError,
  );
  await assertRejects(
    () => getAnnotation(f.school.slug, f.owner, note.id),
    NotFoundError,
  );
  assertEquals(
    (await listAnnotations(f.school.slug, f.teacher, { shared: true })).data
      .length,
    0,
  );
  assertEquals(
    (await listAnnotations(f.other.slug, f.student, { shared: true })).data
      .length,
    0,
  );
  await assertRejects(
    () => getAnnotation(f.other.slug, f.student, note.id),
    NotFoundError,
  );
  const shared = await shareAnnotation(
    f.school.slug,
    f.student,
    note.id,
    "share",
    0,
  );
  assertEquals(
    (await listAnnotations(f.school.slug, f.student)).data.map((n) => n.id),
    [note.id],
  );
  assert(
    (await listAnnotations(f.school.slug, f.student, { shared: true })).data
      .some((n) => n.id === shared.id),
  );
});

Deno.test("全局批注：师生会话使用当前教师组，新任教练接手历史，降级立即失权", async () => {
  const f = await fixture(),
    thread = await createAnnotation(f.school.slug, f.student, "ask", {
      ...f.note,
      visibility: "teaching",
    });
  await assertRejects(
    () => getAnnotation(f.school.slug, f.assistant, thread.id),
    NotFoundError,
  );
  await setMemberRole(f.school.slug, f.owner, f.assistant, "coach");
  assertEquals(
    (await getAnnotation(f.school.slug, f.assistant, thread.id)).messages[0]!
      .body,
    f.note.body,
  );
  await replyAnnotation(
    f.school.slug,
    f.assistant,
    thread.id,
    "reply",
    "先看输入范围。",
  );
  assertEquals(
    (await annotationInbox(f.school.slug, f.student)).unread_count,
    1,
  );
  await markAnnotationRead(f.school.slug, f.student, thread.id);
  assertEquals(
    (await annotationInbox(f.school.slug, f.student)).unread_count,
    0,
  );
  await setMemberRole(f.school.slug, f.owner, f.assistant, "member");
  await assertRejects(
    () => getAnnotation(f.school.slug, f.assistant, thread.id),
    NotFoundError,
  );
  await assertRejects(
    () =>
      replyAnnotation(
        f.school.slug,
        f.assistant,
        thread.id,
        "late",
        "无权回复",
      ),
    NotFoundError,
  );
  assertEquals(
    (await annotationInbox(f.school.slug, f.assistant)).unread_count,
    0,
  );
});

Deno.test("全局批注：发送是独立副本，私人编辑不自动共享，幂等不重复消息和通知", async () => {
  const f = await fixture(),
    note = await createAnnotation(f.school.slug, f.student, "note", f.note);
  assertEquals(
    (await createAnnotation(f.school.slug, f.student, "note", f.note)).id,
    note.id,
  );
  await assertRejects(
    () =>
      createAnnotation(f.school.slug, f.student, "note", {
        ...f.note,
        body: "不同内容",
      }),
    ConflictError,
  );
  const thread = await shareAnnotation(
    f.school.slug,
    f.student,
    note.id,
    "send",
    0,
  );
  assertEquals(
    (await shareAnnotation(f.school.slug, f.student, note.id, "send", 0)).id,
    thread.id,
  );
  await updateAnnotationMessage(
    f.school.slug,
    f.student,
    note.id,
    note.messages[0]!.id,
    0,
    { body: "我的私密补充" },
  );
  assertEquals(
    (await getAnnotation(f.school.slug, f.teacher, thread.id)).messages[0]!
      .body,
    f.note.body,
  );
  await replyAnnotation(
    f.school.slug,
    f.teacher,
    thread.id,
    "same-reply",
    "教练回复",
  );
  await replyAnnotation(
    f.school.slug,
    f.teacher,
    thread.id,
    "same-reply",
    "教练回复",
  );
  assertEquals(
    (await getAnnotation(f.school.slug, f.student, thread.id)).total,
    2,
  );
  assertEquals(
    (await annotationInbox(f.school.slug, f.student)).unread_count,
    1,
  );
});

Deno.test("全局批注：撤销来源后本人正文、引用、历史快照、目录和通知均不可读", async () => {
  const f = await fixture(),
    note = await createAnnotation(f.school.slug, f.student, "note", f.note);
  const thread = await shareAnnotation(
    f.school.slug,
    f.student,
    note.id,
    "send",
    0,
  );
  await f.db.update(domainProblemBindings).set({
    disabled_at: new Date().toISOString(),
  }).where(eq(domainProblemBindings.id, f.bindingId));
  for (const actor of [f.student, f.teacher, f.owner]) {
    await assertRejects(
      () => getAnnotation(f.school.slug, actor, thread.id),
      NotFoundError,
    );
    assertEquals(
      (await listAnnotations(f.school.slug, actor, { shared: true })).data
        .length,
      0,
    );
    assertEquals((await annotationInbox(f.school.slug, actor)).unread_count, 0);
  }
  await assertRejects(
    () => getAnnotation(f.school.slug, f.student, note.id),
    NotFoundError,
  );
  await assertRejects(
    () => getAnnotationOriginal(f.school.slug, f.student, note.id),
    NotFoundError,
  );
  assertEquals((await f.db.select().from(annotationMessages)).length, 2);
});

Deno.test("全局批注：代码笔记固定提交与行，其他学生不能通过会话获得源码", async () => {
  const f = await fixture(),
    target: AnnotationTarget = {
      kind: "submission",
      submission_id: f.id,
      file_name: "main.py",
    };
  const source = await getAnnotationSource(f.school.slug, f.teacher, target);
  const note = await createAnnotation(f.school.slug, f.teacher, "code", {
    target,
    content_hash: source.content_hash,
    anchor: { block_id: "file", start: 6, end: 14 },
    body: "解释这一行",
  });
  assertEquals(note.anchor.quote, "print(a)");
  assertEquals(note.anchor.start_line, 2);
  await assertRejects(
    () =>
      shareAnnotation(
        f.school.slug,
        f.teacher,
        note.id,
        "wrong-student",
        0,
        f.assistant,
      ),
    BadRequestError,
  );
  const shared = await shareAnnotation(
    f.school.slug,
    f.teacher,
    note.id,
    "right-student",
    0,
    f.student,
  );
  assertEquals(shared.student_id, f.student);
  await assertRejects(
    () => getAnnotation(f.school.slug, f.assistant, shared.id),
    NotFoundError,
  );
  assertEquals(
    (await getAnnotation(f.school.slug, f.student, shared.id)).anchor.quote,
    "print(a)",
  );
});

Deno.test("全局批注：题解编辑保留旧定位和完整快照，隐藏后整条会话暂不可读", async () => {
  const f = await fixture(),
    id = crypto.randomUUID(),
    now = new Date().toISOString();
  await f.db.insert(communityPosts).values({
    id,
    domain_id: f.school.id,
    domain_problem_binding_id: f.bindingId,
    type: "solution",
    author_id: f.teacher,
    problem_id: f.problemId,
    title: "题解",
    content: "先排序，再搜索。",
    created_at: now,
    updated_at: now,
  });
  const target: AnnotationTarget = { kind: "solution", post_id: id },
    source = await getAnnotationSource(f.school.slug, f.student, target);
  const note = await createAnnotation(f.school.slug, f.student, "solution", {
    target,
    content_hash: source.content_hash,
    anchor: { block_id: "block:0", start: 0, end: 3 },
    body: "为什么？",
  });
  await f.db.update(communityPosts).set({ content: "使用动态规划。" }).where(
    eq(communityPosts.id, id),
  );
  assertEquals(
    (await getAnnotation(f.school.slug, f.student, note.id)).source_changed,
    true,
  );
  assertEquals(
    (await getAnnotationOriginal(f.school.slug, f.student, note.id)).blocks[0]!
      .text,
    "先排序，再搜索。",
  );
  await f.db.update(communityPosts).set({ status: "hidden" }).where(
    eq(communityPosts.id, id),
  );
  await assertRejects(
    () => getAnnotation(f.school.slug, f.student, note.id),
    NotFoundError,
  );
});

Deno.test("全局批注：平台治理必须显式查询并留痕，普通管理员身份仍不能浏览私人笔记", async () => {
  const f = await fixture(),
    [admin] = await f.db.select().from(roles).where(eq(roles.name, "admin"));
  await f.db.insert(userRoles).values({ user_id: f.owner, role_id: admin.id });
  const note = await createAnnotation(
    f.school.slug,
    f.student,
    "private",
    f.note,
  );
  await assertRejects(
    () => getAnnotation(f.school.slug, f.owner, note.id),
    NotFoundError,
  );
  const governed = await getAnnotation(
    f.school.slug,
    f.owner,
    note.id,
    1,
    "处理学生报告的批注安全问题",
  );
  assertEquals(governed.messages[0]!.body, f.note.body);
  assertEquals(governed.can_reply, false);
  const audits = await f.db.select().from(auditLogs);
  assert(
    audits.some((a) =>
      (a.detail as Record<string, unknown>)?.operation ===
        "annotation.governance.read"
    ),
  );
  await assertRejects(
    () => getAnnotation(f.school.slug, f.teacher, note.id, 1, "无治理权限"),
    ForbiddenError,
  );
});

Deno.test("全局批注：伪造哈希、无效选区和错误版本不会写入；编辑和状态需要前置版本", async () => {
  const f = await fixture();
  await assertRejects(
    () =>
      createAnnotation(f.school.slug, f.student, "hash", {
        ...f.note,
        content_hash: "0".repeat(64),
      }),
    ConflictError,
  );
  await assertRejects(
    () =>
      createAnnotation(f.school.slug, f.student, "range", {
        ...f.note,
        anchor: { block_id: "block:0", start: 0, end: 999 },
      }),
    BadRequestError,
  );
  const note = await createAnnotation(f.school.slug, f.student, "note", f.note);
  await assertRejects(
    () =>
      updateAnnotationMessage(
        f.school.slug,
        f.student,
        note.id,
        note.messages[0]!.id,
        null,
        { body: "修改" },
      ),
    AppError,
  );
  const thread = await shareAnnotation(
    f.school.slug,
    f.student,
    note.id,
    "send",
    0,
  );
  await assertRejects(
    () =>
      updateAnnotationMessage(
        f.school.slug,
        f.teacher,
        thread.id,
        thread.messages[0]!.id,
        0,
        { body: "冒充学生" },
      ),
    ForbiddenError,
  );
  await updateAnnotationThread(f.school.slug, f.teacher, thread.id, 0, {
    state: "resolved",
  });
  assertEquals(
    (await getAnnotation(f.school.slug, f.student, thread.id)).state,
    "resolved",
  );
  await assertRejects(
    () =>
      updateAnnotationThread(f.school.slug, f.student, thread.id, 0, {
        state: "open",
      }),
    ConflictError,
  );
  await updateAnnotationThread(f.school.slug, f.student, thread.id, 1, {
    state: "open",
  });
  assertEquals(
    (await getAnnotation(f.school.slug, f.student, thread.id)).state,
    "open",
  );
});

Deno.test("全局批注：私密代码批注同样保留原提交依据，撤回后不丢失取证原文", async () => {
  const f = await fixture();
  await f.db.update(submissions).set({ status: "finished" }).where(eq(submissions.id, f.id));
  const target: AnnotationTarget = { kind: "submission", submission_id: f.id, file_name: "main.py" };
  const source = await getAnnotationSource(f.school.slug, f.student, target);
  const note = await createAnnotation(f.school.slug, f.student, "retained-source", { target, content_hash: source.content_hash,
    anchor: { block_id: "file", start: 0, end: 5 }, body: "私人代码笔记" });
  const error = await assertRejects(() => deleteSubmission(f.id), ConflictError);
  assertEquals(error.code, "SUBMISSION_HAS_ANNOTATIONS");
  await updateAnnotationThread(f.school.slug, f.student, note.id, 0, { withdraw: true });
  await assertRejects(() => deleteSubmission(f.id), ConflictError);
  assertEquals((await f.db.select().from(submissions).where(eq(submissions.id, f.id))).length, 1);
});

Deno.test("批注通知：授权后游标分页，跨账号游标被拒，未读总数与原文撤权保持一致", async () => {
  const f = await fixture();
  const first = await createAnnotation(f.school.slug, f.student, "notice-first", { ...f.note, visibility: "teaching" });
  const second = await createAnnotation(f.school.slug, f.student, "notice-second", { ...f.note, body: "第二个问题", visibility: "teaching" });
  const page = await annotationInbox(f.school.slug, f.teacher, { limit: 1 });
  assertEquals(page.data.length, 1); assertEquals(page.unread_count, 2); assert(page.next_cursor);
  const next = await annotationInbox(f.school.slug, f.teacher, { cursor: page.next_cursor, limit: 1 });
  assertEquals(next.data.length, 1); assertEquals(next.next_cursor, null); assertEquals(next.unread_count, 2);
  assertEquals(new Set([...page.data, ...next.data].map(notice => notice.thread_id)), new Set([first.id, second.id]));
  await assertRejects(() => annotationInbox(f.school.slug, f.student, { cursor: page.next_cursor! }), NotFoundError);
  await markAnnotationRead(f.school.slug, f.teacher, first.id);
  assertEquals((await annotationInbox(f.school.slug, f.teacher)).unread_count, 1);
  await f.db.update(domainProblemBindings).set({ disabled_at: new Date().toISOString() }).where(eq(domainProblemBindings.id, f.bindingId));
  const revoked = await annotationInbox(f.school.slug, f.teacher);
  assertEquals(revoked.data, []); assertEquals(revoked.unread_count, 0); assertEquals(revoked.next_cursor, null);
  await assertRejects(() => annotationInbox(f.school.slug, f.teacher, { cursor: page.next_cursor! }), NotFoundError);
});
