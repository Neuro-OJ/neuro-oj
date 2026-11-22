import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import {
  classroomMemberships,
  contests,
} from "../../../../shared/db/schema.ts";
import {
  partitionClassroomRanking,
  setContestClassrooms,
} from "../../../contests/services/classroom-contests.ts";
import { createClassroom, setClassroomMember } from "../../index.ts";
import { educationFixture } from "../_fixtures.ts";

Deno.test("班级比赛榜：多班去重、同分排名、筛选补集和即时成员变动", async () => {
  const f = await educationFixture(), now = new Date().toISOString();
  const second = await createClassroom(f.school.slug, f.teacher, {
    name: "二班",
  });
  const foreign = await createClassroom(f.other.slug, f.owner, {
    name: "外域班级",
  });
  for (const room of [f.classroom, second]) {
    await setClassroomMember(f.school.slug, room.id, f.teacher, f.student, 0, {
      role: "student",
    });
  }
  await setClassroomMember(
    f.school.slug,
    second.id,
    f.teacher,
    f.assistant,
    1,
    { role: "student" },
  );
  const id = crypto.randomUUID();
  await f.db.insert(contests).values({
    id,
    domain_id: f.school.id,
    title: "联合班级赛",
    type: "oi",
    created_by: f.owner,
    start_time: now,
    end_time: new Date(Date.now() + 60000).toISOString(),
    created_at: now,
    updated_at: now,
  });
  const link = (ids: string[]) =>
    f.db.transaction((tx) =>
      setContestClassrooms(tx, f.school.id, id, f.teacher, ids)
    );
  await link([f.classroom.id, second.id]);
  await assertRejects(() => link([foreign.id]), BadRequestError);
  await assertRejects(() => link([second.id, second.id]), BadRequestError);
  const rows = [
    { user_id: f.owner, rank: 1, score: 10000 },
    { user_id: f.student, rank: 2, score: 7000 },
    { user_id: f.assistant, rank: 2, score: 7000 },
    { user_id: f.teacher, rank: 4, score: 5000 },
  ];
  const all = await partitionClassroomRanking(id, rows);
  assertEquals(all.rows, rows);
  assertEquals(all.classroom_rows.map((r) => [r.user_id, r.rank]), [[
    f.student,
    1,
  ], [f.assistant, 1]]);
  const filtered = await partitionClassroomRanking(id, rows, f.classroom.id);
  assertEquals(filtered.classroom_rows.map((r) => r.user_id), [f.student]);
  assertEquals(filtered.other_rows.map((r) => r.user_id), [f.owner, f.teacher]);
  await assertRejects(
    () => partitionClassroomRanking(id, rows, foreign.id),
    BadRequestError,
  );
  await f.db.update(classroomMemberships).set({ status: "removed" }).where(and(
    eq(classroomMemberships.user_id, f.student),
    eq(classroomMemberships.domain_id, f.school.id),
  ));
  const moved = await partitionClassroomRanking(id, rows);
  assertEquals(moved.classroom_rows.map((r) => r.user_id), [f.assistant]);
  assertEquals(moved.other_rows.map((r) => [r.user_id, r.rank, r.score]), [
    [f.owner, 1, 10000],
    [f.student, 2, 7000],
    [f.teacher, 3, 5000],
  ]);
});
