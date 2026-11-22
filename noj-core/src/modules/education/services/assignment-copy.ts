import { eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { assignmentItems } from "../../../shared/db/schema.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import { assertClassroomRevision } from "./access.ts";
import { loadAssignment } from "./assignment-access.ts";
import { insertAssignmentDraft } from "./assignments.ts";
import { educationOperation } from "./operations.ts";

/** 任务复制仍属于原班级；部分题目和学生可生成独立补题草稿。 */
export interface AssignmentCopyInput {
  title?: string;
  description?: string;
  item_ids?: string[];
  target_student_ids?: string[] | null;
  deadline_at?: string | null;
  include_previous_submissions?: boolean;
  submission_source?: "assignment_only" | "domain_any";
}

/** 原任务、提交与成绩不修改；复制重新校验当前题库授权和目标学生。 */
export async function copyAssignment(
  slug: string,
  id: string,
  actorId: string,
  revision: number | null,
  key: string,
  input: AssignmentCopyInput,
) {
  return await getDb().transaction(async (tx) => {
    const access = await loadAssignment(slug, id, actorId, {
      executor: tx,
      write: true,
    });
    return await educationOperation(
      tx,
      access.domain.id,
      actorId,
      "assignment.copy",
      key,
      { id, revision, input },
      async () => {
        assertClassroomRevision(access.assignment.revision, revision);
        let items = await tx.select().from(assignmentItems).where(
          eq(assignmentItems.assignment_id, id),
        )
          .orderBy(assignmentItems.sort_order);
        if (input.item_ids !== undefined) {
          if (
            !Array.isArray(input.item_ids) || !input.item_ids.length ||
            new Set(input.item_ids).size !== input.item_ids.length ||
            input.item_ids.some((item) => !items.some((i) => i.id === item))
          ) {
            throw new BadRequestError("复制题目必须来自原作业且不能重复");
          }
          items = items.filter((i) => input.item_ids!.includes(i.id));
        }
        return await insertAssignmentDraft(
          tx,
          access,
          {
            title: input.title ?? `${access.assignment.title}（副本）`,
            description: input.description ?? access.assignment.description,
            deadline_at: input.deadline_at ?? null,
            include_previous_submissions: input.include_previous_submissions ??
              ((input.submission_source ??
                  access.assignment.submission_source) === "assignment_only"
                ? false
                : access.assignment.include_previous_submissions),
            submission_source: input.submission_source ??
              access.assignment.submission_source,
            target_student_ids: input.target_student_ids ?? null,
            ...(access.assignment.source_training_id &&
                !access.assignment.published_at
              ? {
                training: {
                  id: access.assignment.source_training_id,
                  ...access.assignment.source_training_rule!,
                },
              }
              : {
                items: items.map((item) => ({
                  binding_id: item.binding_id,
                  requirement: item.requirement,
                  minimum_score: item.minimum_score,
                })),
              }),
          },
          id,
        );
      },
    );
  });
}
