import { and, count, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { submissionAnnotations, users } from "../../../shared/db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import { workspaceAudit } from "../../access/contracts/cross-module/workspace_services_domains.ts";
import { assertClassroomCapability, loadClassroom } from "./access.ts";
import {
  assertFeedbackAuthor,
  interactionRevision,
  interactionText,
} from "./interaction-access.ts";
import { educationOperation } from "./operations.ts";
import { loadTeachingTextSource, readTeachingText } from "./submission-text.ts";

/** 行批注输入中的哈希由预览接口提供，防止把旧文件的行号写入其他内容。 */
export interface SubmissionAnnotationInput {
  file_name: string;
  source_hash: string;
  start_line: number;
  end_line: number;
  body: string;
}

/** 写批注需同时有源码读取和反馈能力，原提交锁与删除流程协调。 */
export async function createSubmissionAnnotation(
  slug: string,
  classroomId: string,
  id: string,
  actorId: string,
  key: string,
  input: SubmissionAnnotationInput,
) {
  const body = interactionText(input.body);
  if (
    typeof input.file_name !== "string" || !input.file_name ||
    typeof input.source_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.source_hash) ||
    !Number.isSafeInteger(input.start_line) ||
    !Number.isSafeInteger(input.end_line) ||
    input.start_line < 1 || input.end_line < input.start_line
  ) throw new BadRequestError("批注文件、哈希或行范围错误");
  return await getDb().transaction(async (tx) => {
    const access = await loadClassroom(slug, classroomId, actorId, {
      executor: tx,
      write: true,
    });
    assertClassroomCapability(access, "feedback:write");
    const source = await loadTeachingTextSource(access, id, tx, true);
    const text = await readTeachingText(source, input.file_name);
    if (text.source_hash !== input.source_hash) {
      throw new ConflictError(
        "文件内容已变化，请重新打开原提交",
        "SOURCE_HASH_CONFLICT",
      );
    }
    if (input.end_line > text.line_count) {
      throw new BadRequestError("批注行范围超过文件长度");
    }
    return await educationOperation(
      tx,
      access.domain.id,
      actorId,
      "annotation.create",
      key,
      { classroomId, id, ...input, body },
      async () => {
        const now = new Date().toISOString();
        const [annotation] = await tx.insert(submissionAnnotations).values({
          id: crypto.randomUUID(),
          domain_id: access.domain.id,
          classroom_id: classroomId,
          submission_id: id,
          user_id: source.user_id,
          author_id: actorId,
          ...input,
          body,
          created_at: now,
          updated_at: now,
        }).returning();
        await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
          operation: "annotation.create",
          classroom_id: classroomId,
          submission_id: id,
          annotation_id: annotation.id,
        });
        return annotation;
      },
    );
  });
}

/** 学生只读本人批注，撤回记录不在公开列表展示；注销作者仍保留身份依据。 */
export async function listSubmissionAnnotations(
  slug: string,
  classroomId: string,
  id: string,
  actorId: string,
  page = 1,
) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) {
    throw new BadRequestError("分页格式错误");
  }
  const access = await loadClassroom(slug, classroomId, actorId, {
    historicalStudent: true,
  });
  const source = await loadTeachingTextSource(access, id);
  if (!access.managesDomain && source.user_id !== actorId) {
    throw new NotFoundError("批注不存在或不可访问");
  }
  const condition = and(
    eq(submissionAnnotations.domain_id, access.domain.id),
    eq(submissionAnnotations.classroom_id, classroomId),
    eq(submissionAnnotations.submission_id, id),
    isNull(submissionAnnotations.deleted_at),
  );
  const db = getDb(),
    [total] = await db.select({ count: count() }).from(submissionAnnotations)
      .where(condition);
  const rows = await db.select({
    annotation: submissionAnnotations,
    author: sql<
      string
    >`CASE WHEN ${users.deleted_at} IS NOT NULL THEN '已注销用户' ELSE ${users.username} END`,
  })
    .from(submissionAnnotations).innerJoin(
      users,
      eq(users.id, submissionAnnotations.author_id),
    )
    .where(condition).orderBy(
      submissionAnnotations.created_at,
      submissionAnnotations.id,
    ).limit(50).offset((page - 1) * 50);
  return {
    page,
    per_page: 50,
    total: total.count,
    data: rows.map((r) => ({ ...r.annotation, author_name: r.author })),
  };
}

/** 编辑保留原提交、哈希及行范围；作者可改正文，教练或域治理人员可撤回。 */
export async function updateSubmissionAnnotation(
  slug: string,
  classroomId: string,
  id: string,
  annotationId: string,
  actorId: string,
  revision: number | null,
  input: { body?: string; withdraw?: boolean },
) {
  if (input.withdraw !== true && input.body === undefined) {
    throw new BadRequestError("需要批注正文或撤回操作");
  }
  const body = input.body === undefined
    ? undefined
    : interactionText(input.body);
  return await getDb().transaction(async (tx) => {
    const access = await loadClassroom(slug, classroomId, actorId, {
      executor: tx,
      write: true,
    });
    assertClassroomCapability(access, "feedback:write");
    await loadTeachingTextSource(access, id, tx, true);
    const [annotation] = await tx.select().from(submissionAnnotations).where(
      and(
        eq(submissionAnnotations.id, annotationId),
        eq(submissionAnnotations.domain_id, access.domain.id),
        eq(submissionAnnotations.classroom_id, classroomId),
        eq(submissionAnnotations.submission_id, id),
        isNull(submissionAnnotations.deleted_at),
      ),
    ).for("update");
    if (!annotation) throw new NotFoundError("批注不存在");
    interactionRevision(annotation.revision, revision);
    if (
      body !== undefined ||
      !access.managesDomain
    ) {
      assertFeedbackAuthor(annotation.author_id, actorId);
    }
    const [updated] = await tx.update(submissionAnnotations).set({
      body,
      revision: annotation.revision + 1,
      updated_at: new Date().toISOString(),
      deleted_at: input.withdraw ? new Date().toISOString() : undefined,
    }).where(eq(submissionAnnotations.id, annotationId)).returning();
    await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
      operation: input.withdraw ? "annotation.withdraw" : "annotation.update",
      classroom_id: classroomId,
      submission_id: id,
      annotation_id: annotationId,
    });
    return updated;
  });
}
