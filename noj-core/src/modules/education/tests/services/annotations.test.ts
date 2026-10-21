import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { zipSync } from "fflate";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  contests,
  submissionAnnotations,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { deleteSubmission } from "../../../evaluations/index.ts";
import { userActorFromAuthenticatedId } from "../../../access/index.ts";
import { getStorageProvider } from "../../../platform/system/index.ts";
import {
  createSubmissionAnnotation,
  getClassroomStudentSubmission,
  getTeachingTextFile,
  listSubmissionAnnotations,
  listTeachingTextFiles,
  removeClassroomMember,
  setClassroomMember,
  transferClassroom,
  updateSubmissionAnnotation,
} from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

async function fixture() {
  const f = await assignmentFixture();
  const id = await submission(f);
  const text = await getTeachingTextFile(
    f.school.slug,
    f.classroom.id,
    id,
    f.teacher,
    "solution.py",
  );
  const input = {
    file_name: text.file_name,
    source_hash: text.source_hash,
    start_line: 2,
    end_line: 2,
    body: "这里检查边界",
  };
  return { ...f, id, input };
}
async function submission(
  f: Pick<
    Awaited<ReturnType<typeof assignmentFixture>>,
    "db" | "school" | "bindingId" | "student" | "problemId" | "versionId"
  >,
  options: { artifact?: string; contest?: string } = {},
) {
  const id = crypto.randomUUID();
  await f.db.insert(submissions).values({
    id,
    domain_id: f.school.id,
    domain_problem_binding_id: f.bindingId,
    user_id: f.student,
    problem_id: f.problemId,
    language: "python",
    status: "finished",
    code: "print(1)\r\nprint(2)\r\n",
    file_name: "solution.py",
    artifact_storage_url: options.artifact,
    contest_id: options.contest,
    submitted_version_id: f.versionId,
    version_origin: "known",
    created_at: new Date().toISOString(),
  });
  return id;
}

Deno.test("行批注：固定提交与哈希、行号验证、幂等、作者编辑和新提交不继承", async () => {
  const f = await fixture();
  const annotation = await createSubmissionAnnotation(
    f.school.slug,
    f.classroom.id,
    f.id,
    f.teacher,
    "a1",
    f.input,
  );
  assertEquals(annotation.source_hash, f.input.source_hash);
  assertEquals(
    (await createSubmissionAnnotation(
      f.school.slug,
      f.classroom.id,
      f.id,
      f.teacher,
      "a1",
      f.input,
    )).id,
    annotation.id,
  );
  await assertRejects(
    () =>
      createSubmissionAnnotation(
        f.school.slug,
        f.classroom.id,
        f.id,
        f.teacher,
        "bad-hash",
        { ...f.input, source_hash: "0".repeat(64) },
      ),
    ConflictError,
  );
  await assertRejects(
    () =>
      createSubmissionAnnotation(
        f.school.slug,
        f.classroom.id,
        f.id,
        f.teacher,
        "bad-lines",
        { ...f.input, end_line: 4 },
      ),
    BadRequestError,
  );
  assertEquals(
    (await listSubmissionAnnotations(
      f.school.slug,
      f.classroom.id,
      f.id,
      f.student,
    )).total,
    1,
  );
  assertEquals(
    (await listSubmissionAnnotations(
      f.school.slug,
      f.classroom.id,
      await submission(f),
      f.teacher,
    )).total,
    0,
  );
  await assertRejects(
    () =>
      updateSubmissionAnnotation(
        f.school.slug,
        f.classroom.id,
        f.id,
        annotation.id,
        f.teacher,
        null,
        { body: "新反馈" },
      ),
    AppError,
  );
  await assertRejects(
    () =>
      updateSubmissionAnnotation(
        f.school.slug,
        f.classroom.id,
        f.id,
        annotation.id,
        f.owner,
        0,
        { body: "改写" },
      ),
    ForbiddenError,
  );
  const updated = await updateSubmissionAnnotation(
    f.school.slug,
    f.classroom.id,
    f.id,
    annotation.id,
    f.teacher,
    0,
    { body: "补充边界提示" },
  );
  assertEquals(updated.revision, 1);
  await assertRejects(
    () =>
      updateSubmissionAnnotation(
        f.school.slug,
        f.classroom.id,
        f.id,
        annotation.id,
        f.teacher,
        0,
        { body: "过时反馈" },
      ),
    AppError,
  );
  await updateSubmissionAnnotation(
    f.school.slug,
    f.classroom.id,
    f.id,
    annotation.id,
    f.owner,
    1,
    { withdraw: true },
  );
  assertEquals(
    (await listSubmissionAnnotations(
      f.school.slug,
      f.classroom.id,
      f.id,
      f.student,
    )).total,
    0,
  );
  assertEquals(
    (await f.db.select().from(submissionAnnotations))[0].body,
    "补充边界提示",
  );
});

Deno.test("行批注：错误域、同学、独立助教能力、离班历史及教师撤职即时生效", async () => {
  const f = await fixture();
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    1,
    { role: "student" },
  );
  await assertRejects(
    () =>
      listSubmissionAnnotations(
        f.school.slug,
        f.classroom.id,
        f.id,
        f.assistant,
      ),
    NotFoundError,
  );
  await assertRejects(
    () =>
      listSubmissionAnnotations(f.other.slug, f.classroom.id, f.id, f.owner),
    NotFoundError,
  );
  await assertRejects(
    () =>
      createSubmissionAnnotation(
        f.school.slug,
        f.classroom.id,
        f.id,
        f.student,
        "student",
        f.input,
      ),
    ForbiddenError,
  );
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    2,
    { role: "assistant", capabilities: ["feedback:write"] },
  );
  await assertRejects(
    () =>
      createSubmissionAnnotation(
        f.school.slug,
        f.classroom.id,
        f.id,
        f.assistant,
        "feedback-only",
        f.input,
      ),
    ForbiddenError,
  );
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    3,
    { role: "assistant", capabilities: ["submissions:read"] },
  );
  await assertRejects(
    () =>
      createSubmissionAnnotation(
        f.school.slug,
        f.classroom.id,
        f.id,
        f.assistant,
        "code-only",
        f.input,
      ),
    ForbiddenError,
  );
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    4,
    { role: "assistant", capabilities: ["feedback:write", "submissions:read"] },
  );
  await createSubmissionAnnotation(
    f.school.slug,
    f.classroom.id,
    f.id,
    f.assistant,
    "authorized",
    f.input,
  );
  await removeClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    5,
  );
  assertEquals(
    (await listSubmissionAnnotations(
      f.school.slug,
      f.classroom.id,
      f.id,
      f.student,
    )).total,
    1,
  );
  assertEquals(
    (await getClassroomStudentSubmission(
      f.school.slug,
      f.classroom.id,
      f.id,
      "submission",
      f.teacher,
    )).code,
    "print(1)\r\nprint(2)\r\n",
  );
  const later = await submission(f);
  await assertRejects(
    () =>
      getTeachingTextFile(
        f.school.slug,
        f.classroom.id,
        later,
        f.teacher,
        "solution.py",
      ),
    NotFoundError,
  );
  await setClassroomMember(f.school.slug, f.classroom.id, f.owner, f.owner, 6, {
    role: "coach",
  });
  await transferClassroom(f.school.slug, f.classroom.id, f.owner, f.owner, 7);
  await removeClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.owner,
    f.teacher,
    8,
  );
  await assertRejects(
    () =>
      listSubmissionAnnotations(f.school.slug, f.classroom.id, f.id, f.teacher),
    NotFoundError,
  );
});

Deno.test("行批注：进行中比赛禁止教练旁路，数据库拒绝错学生引用及删除保留依据", async () => {
  const f = await fixture(),
    contest = crypto.randomUUID(),
    now = new Date().toISOString();
  await f.db.insert(contests).values({
    id: contest,
    domain_id: f.school.id,
    title: "OI",
    type: "oi",
    created_by: f.owner,
    start_time: now,
    end_time: new Date(Date.now() + 60000).toISOString(),
    created_at: now,
    updated_at: now,
  });
  const hidden = await submission(f, { contest });
  await assertRejects(
    () =>
      createSubmissionAnnotation(
        f.school.slug,
        f.classroom.id,
        hidden,
        f.teacher,
        "hidden",
        f.input,
      ),
    NotFoundError,
  );
  await assertRejects(
    () =>
      getTeachingTextFile(
        f.school.slug,
        f.classroom.id,
        hidden,
        f.student,
        "solution.py",
      ),
    NotFoundError,
  );
  const annotation = await createSubmissionAnnotation(
    f.school.slug,
    f.classroom.id,
    f.id,
    f.teacher,
    "retain",
    f.input,
  );
  await assertRejects(() =>
    f.db.transaction(async (tx) =>
      await tx.insert(submissionAnnotations).values({
        ...annotation,
        id: crypto.randomUUID(),
        user_id: f.assistant,
      })
    )
  );
  await assertRejects(
    () => deleteSubmission(userActorFromAuthenticatedId(f.student), f.id),
    ConflictError,
    "需要保留原代码依据",
  );
  await deleteSubmission(
    userActorFromAuthenticatedId(f.student),
    await submission(f),
  );
  await f.db.update(users).set({ deleted_at: now }).where(
    eq(users.id, f.teacher),
  );
  assertEquals(
    (await listSubmissionAnnotations(
      f.school.slug,
      f.classroom.id,
      f.id,
      f.student,
    )).data[0].author_name,
    "已注销用户",
  );
});

Deno.test("产物文本预览：仅学生上传包、嵌套文本、二进制排除、无存储地址且逐次检查权限", async () => {
  const f = await assignmentFixture(), storage = await getStorageProvider();
  const artifact = await storage.put(
    `education-preview/${crypto.randomUUID()}.zip`,
    zipSync({
      "src/train.py": new TextEncoder().encode("print(1)\nprint(2)"),
      "notes.txt": new TextEncoder().encode("学生说明"),
      "binary.txt": new Uint8Array([0, 1, 2]),
      "weights.bin": new Uint8Array([1, 2, 3]),
      "large.txt": new Uint8Array(1024 * 1024 + 1).fill(65),
    }),
  );
  try {
    const id = await submission(f, { artifact });
    const files = await listTeachingTextFiles(
      f.school.slug,
      f.classroom.id,
      id,
      f.teacher,
    );
    assertEquals(files.files.map((r) => r.file_name).sort(), [
      "notes.txt",
      "src/train.py",
    ]);
    assertEquals(JSON.stringify(files).includes("noj-storage"), false);
    const text = await getTeachingTextFile(
      f.school.slug,
      f.classroom.id,
      id,
      f.student,
      "src/train.py",
    );
    assertEquals(text.text, "print(1)\nprint(2)");
    await createSubmissionAnnotation(
      f.school.slug,
      f.classroom.id,
      id,
      f.teacher,
      "artifact",
      {
        file_name: text.file_name,
        source_hash: text.source_hash,
        start_line: 1,
        end_line: 2,
        body: "检查训练过程",
      },
    );
    await assertRejects(
      () =>
        getTeachingTextFile(
          f.school.slug,
          f.classroom.id,
          id,
          f.teacher,
          "binary.txt",
        ),
      BadRequestError,
    );
    await assertRejects(
      () =>
        getTeachingTextFile(
          f.school.slug,
          f.classroom.id,
          id,
          f.teacher,
          "../evaluate.py",
        ),
      NotFoundError,
    );
    await assertRejects(
      () => listTeachingTextFiles(f.other.slug, f.classroom.id, id, f.owner),
      NotFoundError,
    );
  } finally {
    await storage.delete(artifact);
  }
});

Deno.test("产物文本预览：解压前拒绝路径穿越和超过 ZIP 条目上限", async () => {
  const f = await assignmentFixture(), storage = await getStorageProvider();
  const bytes = new TextEncoder().encode("source");
  for (
    const entries of [
      { "../escape.py": bytes },
      Object.fromEntries(
        Array.from({ length: 1001 }, (_, i) => [`${i}.txt`, bytes]),
      ),
    ]
  ) {
    const artifact = await storage.put(
      `education-preview/${crypto.randomUUID()}.zip`,
      zipSync(entries),
    );
    try {
      const id = await submission(f, { artifact });
      await assertRejects(
        () =>
          listTeachingTextFiles(f.school.slug, f.classroom.id, id, f.teacher),
        BadRequestError,
      );
    } finally {
      await storage.delete(artifact);
    }
  }
});
