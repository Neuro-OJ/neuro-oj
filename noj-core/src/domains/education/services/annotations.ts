import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import {
  createAnnotation,
  getAnnotation,
  getAnnotationSource,
  listAnnotations,
  updateAnnotationMessage,
  updateAnnotationThread,
} from "../../annotation/index.ts";
import { assertClassroomCapability, loadClassroom } from "./access.ts";
import { loadTeachingTextSource } from "./submission-text.ts";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { educationOperations } from "../../../shared/db/schema.ts";
import { educationRequestHash } from "./operations.ts";

/** 旧课堂入口仍明确创建定向教学反馈；新页面一律使用默认私密的全局入口。 */
export interface SubmissionAnnotationInput {
  file_name: string;
  source_hash: string;
  start_line: number;
  end_line: number;
  body: string;
}
type Detail = Awaited<ReturnType<typeof getAnnotation>>;
function legacyShape(detail: Detail, classroomId: string) {
  if (detail.target.kind !== "submission" || detail.visibility !== "teaching") {
    throw new NotFoundError("行批注不存在");
  }
  const first = detail.messages[0];
  return {
    id: detail.id,
    domain_id: detail.domain_id,
    classroom_id: classroomId,
    submission_id: detail.target.submission_id,
    file_name: detail.target.file_name,
    user_id: detail.student_id!,
    author_id: detail.owner_id,
    author_name: detail.author?.username,
    author: detail.author,
    source_hash: detail.content_hash,
    start_line: detail.anchor.start_line,
    end_line: detail.anchor.end_line,
    body: first?.body ?? "",
    revision: first?.revision ?? detail.revision,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
    deleted_at: null as string | null,
  };
}
async function classroomSource(
  slug: string,
  classroomId: string,
  id: string,
  actorId: string,
  write = false,
) {
  const access = await loadClassroom(slug, classroomId, actorId, {
    historicalStudent: !write,
    write,
  });
  if (write) assertClassroomCapability(access, "feedback:write");
  await loadTeachingTextSource(access, id);
  return access;
}

/** 旧行号转换为规范选区；正文、幂等与通知只写入全局批注表。 */
export async function createSubmissionAnnotation(
  slug: string,
  classroomId: string,
  id: string,
  actorId: string,
  key: string,
  input: SubmissionAnnotationInput,
) {
  const access = await classroomSource(slug, classroomId, id, actorId, true);
  if (typeof key !== "string" || !key.trim() || key.length > 200) throw new BadRequestError("需要 Idempotency-Key", "IDEMPOTENCY_KEY_REQUIRED");
  if (
    typeof input.file_name !== "string" || !input.file_name ||
    !Number.isSafeInteger(input.start_line) ||
    !Number.isSafeInteger(input.end_line) || input.start_line < 1 ||
    input.end_line < input.start_line
  ) throw new BadRequestError("批注文件或行范围错误");
  const target = {
    kind: "submission" as const,
    submission_id: id,
    file_name: input.file_name,
  };
  const source = await getAnnotationSource(slug, actorId, target),
    text = source.blocks[0]!.text;
  if (source.content_hash !== input.source_hash) {
    throw new ConflictError(
      "文件内容已变化，请重新打开原提交",
      "SOURCE_HASH_CONFLICT",
    );
  }
  const lines = text.split("\n");
  if (input.end_line > lines.length) {
    throw new BadRequestError("批注行范围超过文件长度");
  }
  const start = input.start_line === 1
    ? 0
    : lines.slice(0, input.start_line - 1).join("\n").length + 1;
  const end = lines.slice(0, input.end_line).join("\n").length;
  const [previous] = await getDb().select().from(educationOperations).where(and(
    eq(educationOperations.domain_id, access.domain.id), eq(educationOperations.actor_id, actorId),
    eq(educationOperations.operation, "annotation.create"), eq(educationOperations.idempotency_key, key),
  ));
  if (previous) {
    const hash = await educationRequestHash({ classroomId, id, ...input, body: typeof input.body === "string" ? input.body.trim() : input.body });
    if (hash !== previous.request_hash) throw new ConflictError("幂等键已用于不同请求", "IDEMPOTENCY_CONFLICT");
    const originalId = (previous.result as Record<string, unknown>).id;
    if (typeof originalId !== "string") throw new NotFoundError("历史批注不存在");
    return legacyShape(await getAnnotation(slug, actorId, originalId), classroomId);
  }
  return legacyShape(
    await createAnnotation(slug, actorId, `legacy:${await educationRequestHash(key)}`, {
      target,
      content_hash: source.content_hash,
      anchor: { block_id: "file", start, end },
      body: input.body,
      visibility: "teaching",
    }),
    classroomId,
  );
}

/** 兼容旧分页，但每条记录仍经全局会话的当前原文与受众校验。 */
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
  await classroomSource(slug, classroomId, id, actorId);
  const visible: Awaited<ReturnType<typeof listAnnotations>>["data"] = [];
  let cursor: string | undefined;
  do {
    const result = await listAnnotations(slug, actorId, {
      shared: true,
      teachingOnly: true,
      submissionId: id,
      cursor,
      limit: 50,
    });
    visible.push(...result.data);
    cursor = result.next_cursor ?? undefined;
  } while (cursor);
  const data = [];
  for (const thread of visible.slice((page - 1) * 50, page * 50)) {
    data.push(
      legacyShape(await getAnnotation(slug, actorId, thread.id), classroomId),
    );
  }
  return { page, per_page: 50, total: visible.length, data };
}

/** 兼容旧 ID；只改全局消息，撤回整个会话不会让旧表正文重新出现。 */
export async function updateSubmissionAnnotation(
  slug: string,
  classroomId: string,
  id: string,
  annotationId: string,
  actorId: string,
  revision: number | null,
  input: { body?: string; withdraw?: boolean; reason?: string },
) {
  await classroomSource(slug, classroomId, id, actorId, true);
  const detail = await getAnnotation(slug, actorId, annotationId),
    previous = legacyShape(detail, classroomId);
  if (previous.submission_id !== id) throw new NotFoundError("行批注不存在");
  if (input.withdraw) {
    await updateAnnotationThread(slug, actorId, annotationId, revision, {
      withdraw: true,
      reason: input.reason,
    });
    return {
      ...previous,
      revision: previous.revision + 1,
      deleted_at: new Date().toISOString(),
    };
  }
  return legacyShape(
    await updateAnnotationMessage(
      slug,
      actorId,
      annotationId,
      detail.messages[0]!.id,
      revision,
      { body: input.body },
    ),
    classroomId,
  );
}
