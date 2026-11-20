import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Executor } from "../../../shared/db/executor.ts";
import { getDb } from "../../../shared/db/connection.ts";
import {
  classroomContestLinks,
  classroomMemberships,
  classrooms,
  domainMemberships,
  users,
} from "../../../shared/db/schema.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";

/** 比赛拥有关联关系；只允许选择同域有效班级，不改变原有报名与可见性。 */
export async function setContestClassrooms(
  tx: Executor,
  domainId: string,
  contestId: string,
  actorId: string,
  ids: string[],
) {
  if (
    !Array.isArray(ids) || ids.length > 100 ||
    ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length
  ) {
    throw new BadRequestError("关联班级必须是至多 100 个不同的本域班级");
  }
  if (ids.length) {
    const rows = await tx.select({ id: classrooms.id }).from(classrooms).where(
      and(
        eq(classrooms.domain_id, domainId),
        eq(classrooms.status, "active"),
        inArray(classrooms.id, ids),
      ),
    ).for("share");
    if (rows.length !== ids.length) {
      throw new BadRequestError("关联班级不存在、已归档或不属于本域");
    }
  }
  await tx.delete(classroomContestLinks).where(
    eq(classroomContestLinks.contest_id, contestId),
  );
  if (ids.length) {
    await tx.insert(classroomContestLinks).values(ids.map((id) => ({
      domain_id: domainId,
      classroom_id: id,
      contest_id: contestId,
      linked_by: actorId,
      linked_at: new Date().toISOString(),
    })));
  }
}

/** 读取当前关联班级，名单变化不修改比赛的正式成绩快照。 */
export async function contestClassrooms(contestId: string) {
  return await getDb().select({ id: classrooms.id, name: classrooms.name })
    .from(classroomContestLinks).innerJoin(
      classrooms,
      and(
        eq(classrooms.id, classroomContestLinks.classroom_id),
        eq(classrooms.status, "active"),
      ),
    )
    .where(eq(classroomContestLinks.contest_id, contestId)).orderBy(
      classrooms.created_at,
      classrooms.id,
    );
}

/** 在原赛制引擎完成保密、封榜和正式成绩选择后，按当前学生名单分组。 */
export async function partitionClassroomRanking<
  T extends { user_id: string; rank: number },
>(
  contestId: string,
  rows: T[],
  classroomId?: string,
) {
  const linked = await contestClassrooms(contestId);
  if (classroomId && !linked.some((room) => room.id === classroomId)) {
    throw new BadRequestError("只能筛选此比赛关联的班级");
  }
  if (!linked.length) {
    return {
      rows,
      classrooms: linked,
      classroom_rows: [] as T[],
      other_rows: [] as T[],
    };
  }
  const members = await getDb().select({
    user_id: classroomMemberships.user_id,
    classroom_id: classroomMemberships.classroom_id,
  }).from(classroomMemberships)
    .innerJoin(
      users,
      and(eq(users.id, classroomMemberships.user_id), isNull(users.deleted_at)),
    )
    .innerJoin(
      domainMemberships,
      and(
        eq(domainMemberships.domain_id, classroomMemberships.domain_id),
        eq(domainMemberships.user_id, classroomMemberships.user_id),
        eq(domainMemberships.status, "active"),
      ),
    ).where(and(
      eq(classroomMemberships.status, "active"),
      eq(classroomMemberships.role, "student"),
      inArray(classroomMemberships.classroom_id, linked.map((room) => room.id)),
    ));
  const selected = new Set(members.map((member) => member.user_id));
  const filtered = classroomId
    ? new Set(
      members.filter((member) => member.classroom_id === classroomId).map((
        member,
      ) => member.user_id),
    )
    : selected;
  // 原 rank 相同的行仍同名次；筛选后按竞赛排名规则补齐空位。
  const rerank = (group: T[]) => {
    let previous: number | undefined, rank = 0;
    return group.map((row, index) => {
      if (row.rank !== previous) rank = index + 1;
      previous = row.rank;
      return { ...row, rank };
    });
  };
  return {
    rows,
    classrooms: linked,
    classroom_rows: rerank(rows.filter((row) => filtered.has(row.user_id))),
    other_rows: rerank(rows.filter((row) => !selected.has(row.user_id))),
  };
}
