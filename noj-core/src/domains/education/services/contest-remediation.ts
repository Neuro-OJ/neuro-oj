import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  classroomMemberships,
  domainMemberships,
  users,
} from "../../../shared/db/schema.ts";
import { BadRequestError, ConflictError } from "../../../shared/base/errors.ts";
import { loadBindingAvailability } from "../../../modules/problems/index.ts";
import { loadContestTeachingBasis } from "../../../modules/contests/index.ts";
import { workspaceAudit } from "../../workspace/index.ts";
import {
  assertClassroomCapability,
  assertClassroomRevision,
  loadClassroom,
} from "./access.ts";
import { insertAssignmentDraft } from "./assignments.ts";
import { educationOperation, educationRequestHash } from "./operations.ts";

/** 比赛成绩仅用于选人选题；新作业仍跟随本域题库口径。 */
export interface ContestRemediationRule {
  contest_id: string;
  ranking_source: "live" | "official";
  requirement: "accepted" | "min_score";
  minimum_score?: number | null;
}

async function buildPreview(
  access: Awaited<ReturnType<typeof loadClassroom>>,
  actorId: string,
  input: ContestRemediationRule,
  tx: Executor,
) {
  assertClassroomCapability(access, "progress:read");
  assertClassroomCapability(access, "assignments:manage");
  if (
    typeof input.contest_id !== "string" ||
    !["live", "official"].includes(input.ranking_source) ||
    !["accepted", "min_score"].includes(input.requirement) ||
    input.requirement === "accepted" && input.minimum_score != null ||
    input.requirement === "min_score" &&
      (!Number.isSafeInteger(input.minimum_score) || input.minimum_score! < 0 ||
        input.minimum_score! > 10000)
  ) throw new BadRequestError("比赛来源和达标规则无效");
  const basis = await loadContestTeachingBasis(
    access.domain.slug,
    input.contest_id,
    actorId,
    input.ranking_source,
    tx,
  );
  const resources = new Map(
    (await loadBindingAvailability(
      tx,
      access.domain.id,
      basis.items.map((i) => i.binding_id).filter((id): id is string => !!id),
    )).map((r) => [r.id, r]),
  );
  const items = basis.items.map((item) => ({
    ...item,
    requirement: input.requirement,
    minimum_score: input.minimum_score ?? null,
    resource_available: item.binding_id !== null &&
      (resources.get(item.binding_id)?.available ?? false),
    policy_revision: item.binding_id
      ? resources.get(item.binding_id)?.revision ?? 0
      : 0,
  }));
  const current = await tx.select({
    user_id: classroomMemberships.user_id,
    username: users.username,
  })
    .from(classroomMemberships).innerJoin(
      users,
      eq(users.id, classroomMemberships.user_id),
    )
    .innerJoin(
      domainMemberships,
      and(
        eq(domainMemberships.domain_id, classroomMemberships.domain_id),
        eq(domainMemberships.user_id, classroomMemberships.user_id),
      ),
    )
    .where(
      and(
        eq(classroomMemberships.classroom_id, access.classroom.id),
        eq(classroomMemberships.role, "student"),
        eq(classroomMemberships.status, "active"),
        eq(domainMemberships.status, "active"),
        isNull(users.deleted_at),
      ),
    ).orderBy(asc(classroomMemberships.user_id));
  const historical = await tx.select({ id: classroomMemberships.id }).from(
    classroomMemberships,
  ).where(
    and(
      eq(classroomMemberships.classroom_id, access.classroom.id),
      eq(classroomMemberships.role, "student"),
      eq(classroomMemberships.status, "removed"),
    ),
  );
  const rankings = new Map(basis.students.map((r) => [r.user_id, r]));
  const usable = new Set(
    items.filter((i) => i.resource_available).map((i) => i.id),
  );
  let pending = 0, nonparticipants = 0;
  const students = current.flatMap((student) => {
    const row = rankings.get(student.user_id);
    if (!row) {
      nonparticipants++;
      return [];
    }
    const itemIds = row.cells.filter((cell) => {
      if (!usable.has(cell.item_id)) return false;
      if (cell.pending || cell.score === null) {
        pending++;
        return false;
      }
      return input.requirement === "accepted"
        ? !cell.accepted
        : cell.score < input.minimum_score!;
    }).map((cell) => cell.item_id);
    return itemIds.length ? [{ ...student, item_ids: itemIds }] : [];
  });
  const preview = {
    source: basis.source,
    updating: false,
    students,
    items,
    excluded: {
      pending_cells: pending,
      unavailable_items: items.filter((i) => !i.resource_available).length,
      historical_students: historical.length,
      nonparticipants,
    },
  };
  return {
    ...preview,
    preview_token: await educationRequestHash({
      actor_id: actorId,
      ...preview,
    }),
  };
}

/** 教师身份不能越过比赛本人榜、保密或封榜规则；只返回已授权候选。 */
export async function previewContestRemediation(
  slug: string,
  classroomId: string,
  actorId: string,
  input: ContestRemediationRule,
) {
  const access = await loadClassroom(slug, classroomId, actorId);
  return await buildPreview(access, actorId, input, getDb());
}

/** 创建输入不接受域或原成绩覆盖，只包含已经预览的学生与源题。 */
export interface ContestRemediationInput extends ContestRemediationRule {
  title: string;
  target_student_ids: string[];
  item_ids: string[];
  preview_token: string;
  deadline_at?: string | null;
}

/** 在原班级建立有比赛来源的独立草稿，正式榜及比赛提交均不修改。 */
export async function createContestRemediation(
  slug: string,
  classroomId: string,
  actorId: string,
  revision: number | null,
  key: string,
  input: ContestRemediationInput,
) {
  return await getDb().transaction(async (tx) => {
    const access = await loadClassroom(slug, classroomId, actorId, {
      write: true,
      executor: tx,
    });
    assertClassroomCapability(access, "assignments:manage");
    assertClassroomCapability(access, "progress:read");
    return await educationOperation(
      tx,
      access.domain.id,
      actorId,
      "contest.remediation",
      key,
      { classroomId, revision, input },
      async () => {
        const preview = await buildPreview(access, actorId, input, tx);
        assertClassroomRevision(preview.source.revision, revision);
        if (
          input.preview_token !== preview.preview_token
        ) {
          throw new ConflictError(
            "比赛补题依据已变化，请重新预览",
            "REMEDIATION_PREVIEW_CHANGED",
          );
        }
        if (
          !Array.isArray(input.target_student_ids) ||
          !input.target_student_ids.length || !Array.isArray(input.item_ids) ||
          !input.item_ids.length ||
          new Set(input.target_student_ids).size !==
            input.target_student_ids.length ||
          new Set(input.item_ids).size !== input.item_ids.length
        ) throw new BadRequestError("请选择不同的学生及题目");
        const chosen = new Set(input.item_ids);
        const eligible = new Set(
          preview.students.filter((s) =>
            s.item_ids.some((id) => chosen.has(id))
          ).map((s) => s.user_id),
        );
        const candidates = new Set(preview.students.flatMap((s) => s.item_ids));
        if (
          input.target_student_ids.some((id) => !eligible.has(id)) ||
          input.item_ids.some((id) => !candidates.has(id))
        ) throw new BadRequestError("所选学生或题目不属于当前候选");
        const draft = await insertAssignmentDraft(
          tx,
          access,
          {
            title: input.title,
            deadline_at: input.deadline_at,
            target_student_ids: input.target_student_ids,
            items: preview.items.filter((i) => chosen.has(i.id)).map((i) => ({
              binding_id: i.binding_id!,
              requirement: i.requirement,
              minimum_score: i.minimum_score,
            })),
          },
          undefined,
          preview.source.id,
        );
        await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
          operation: "assignment.contest_remediation",
          assignment_id: draft.id,
          source_contest_id: preview.source.id,
          ranking_source: preview.source.ranking_source,
          snapshot_version: preview.source.snapshot_version,
          source_revision: preview.source.revision,
          requirement: input.requirement,
          minimum_score: input.minimum_score ?? null,
          preview_token: preview.preview_token,
        });
        return draft;
      },
    );
  });
}
