import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import {
  annotationMessages,
  annotationSources,
  annotationThreads,
  submissionAnnotations,
} from "../../../shared/db/schema.ts";
import { AppError } from "../../../shared/base/errors.ts";
import { loadWorkspace } from "../../workspace/index.ts";
import { loadAnnotationTarget } from "./sources.ts";
import { annotationAnchor, annotationBlocks, annotationHash } from "./text.ts";

/** 历史行批注保留原 ID，按需转为教学会话；新表成为唯一后续编辑依据。 */
export async function importLegacyAnnotations(
  slug: string,
  actorId: string,
  options: { id?: string; submissionId?: string } = {},
) {
  const workspace = await loadWorkspace(slug, actorId);
  if (!workspace.membership || workspace.domain.preset !== "education") return;
  const faculty = workspace.role === "owner" || workspace.role === "coach";
  const rows = await getDb().select().from(submissionAnnotations).where(and(
    eq(submissionAnnotations.domain_id, workspace.domain.id),
    isNull(submissionAnnotations.deleted_at),
    faculty ? undefined : eq(submissionAnnotations.user_id, actorId),
    options.id ? eq(submissionAnnotations.id, options.id) : undefined,
    options.submissionId
      ? eq(submissionAnnotations.submission_id, options.submissionId)
      : undefined,
    sql`NOT EXISTS (SELECT 1 FROM ${annotationThreads} WHERE ${annotationThreads.id} = ${submissionAnnotations.id})`,
  ));
  for (const old of rows) {
    try {
      const live = await loadAnnotationTarget(slug, actorId, {
        kind: "submission",
        submission_id: old.submission_id,
        file_name: old.file_name,
      });
      if (await annotationHash(live.content) !== old.source_hash) continue;
      const blocks = annotationBlocks(live.content, true),
        lines = blocks[0]!.text.split("\n");
      if (old.start_line < 1 || old.end_line > lines.length) continue;
      const start = old.start_line === 1
        ? 0
        : lines.slice(0, old.start_line - 1).join("\n").length + 1;
      const end = lines.slice(0, old.end_line).join("\n").length;
      const anchor = annotationAnchor(blocks, { block_id: "file", start, end });
      await getDb().transaction(async (tx) => {
        const [inserted] = await tx.insert(annotationSources).values({
          id: crypto.randomUUID(),
          domain_id: old.domain_id,
          target: live.target,
          target_key: live.target_key,
          content_hash: old.source_hash,
          content: live.content,
          created_at: old.created_at,
        }).onConflictDoNothing().returning();
        const source = inserted ??
          (await tx.select().from(annotationSources).where(
            and(
              eq(annotationSources.domain_id, old.domain_id),
              eq(annotationSources.target_key, live.target_key),
              eq(annotationSources.content_hash, old.source_hash),
            ),
          ))[0]!;
        const [thread] = await tx.insert(annotationThreads).values({
          id: old.id,
          domain_id: old.domain_id,
          source_id: source.id,
          owner_id: old.author_id,
          student_id: old.user_id,
          visibility: "teaching",
          anchor,
          revision: old.revision,
          created_at: old.created_at,
          updated_at: old.updated_at,
        }).onConflictDoNothing().returning();
        if (thread) {
          await tx.insert(annotationMessages).values({
            id: old.id,
            domain_id: old.domain_id,
            thread_id: old.id,
            author_id: old.author_id,
            body: old.body,
            revision: old.revision,
            created_at: old.created_at,
            updated_at: old.updated_at,
          });
        }
      });
    } catch (error) {
      // 当前原文失权或旧文件不可预览时不暴露正文；重新授权后仍可重试迁移。
      if (
        !(error instanceof AppError &&
          [400, 401, 403, 404, 422].includes(error.statusCode))
      ) throw error;
    }
  }
}
