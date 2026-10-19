import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { annotationMessages, annotationThreads, educationOperations, submissionAnnotations, submissions } from "../../../shared/db/schema.ts";
import { BadRequestError, ConflictError } from "../../../shared/base/errors.ts";
import { assignmentFixture } from "../../education/tests/_assignment-fixture.ts";
import { createSubmissionAnnotation } from "../../education/index.ts";
import { getAnnotationSource } from "../services/sources.ts";
import { annotationHash } from "../services/text.ts";
import { updateAnnotationMessage } from "../services/threads.ts";

Deno.test("旧批注幂等：升级前的键保留原 ID，重试读取当前正文，空键与修改请求被拒", async () => {
  const f = await assignmentFixture(), submissionId = crypto.randomUUID(), oldId = crypto.randomUUID(), now = new Date().toISOString();
  await f.db.insert(submissions).values({ id: submissionId, domain_id: f.school.id, domain_problem_binding_id: f.bindingId,
    user_id: f.student, problem_id: f.problemId, language: "python", code: "print(1)", file_name: "main.py", status: "finished",
    submitted_version_id: f.versionId, version_origin: "known", created_at: now });
  const source = await getAnnotationSource(f.school.slug, f.teacher, { kind: "submission", submission_id: submissionId, file_name: "main.py" });
  const input = { file_name: "main.py", source_hash: source.content_hash, start_line: 1, end_line: 1, body: "升级前的批注" };
  const [old] = await f.db.insert(submissionAnnotations).values({ id: oldId, domain_id: f.school.id, classroom_id: f.classroom.id,
    submission_id: submissionId, user_id: f.student, author_id: f.teacher, ...input, created_at: now, updated_at: now }).returning();
  await f.db.insert(educationOperations).values({ id: crypto.randomUUID(), domain_id: f.school.id, actor_id: f.teacher,
    operation: "annotation.create", idempotency_key: "before-upgrade", result: old, created_at: now,
    request_hash: await annotationHash(JSON.stringify({ classroomId: f.classroom.id, id: submissionId, ...input, body: input.body })) });
  const retry = () => createSubmissionAnnotation(f.school.slug, f.classroom.id, submissionId, f.teacher, "before-upgrade", input);
  assertEquals((await retry()).id, oldId);
  assertEquals((await retry()).id, oldId);
  assertEquals((await f.db.select().from(annotationThreads)).length, 1);
  assertEquals((await f.db.select().from(annotationMessages)).length, 1);
  await updateAnnotationMessage(f.school.slug, f.teacher, oldId, oldId, 0, { body: "当前正文" });
  assertEquals((await retry()).body, "当前正文");
  await assertRejects(() => createSubmissionAnnotation(f.school.slug, f.classroom.id, submissionId, f.teacher, "before-upgrade", { ...input, body: "不同请求" }), ConflictError);
  await assertRejects(() => createSubmissionAnnotation(f.school.slug, f.classroom.id, submissionId, f.teacher, "", input), BadRequestError);
});
