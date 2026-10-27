import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import {
  classroomMemberships,
  classrooms,
  contestParticipants,
  contestProblems,
  contests,
  submissions,
} from "../../../../shared/db/schema.ts";
import { setDomainProblemSharing } from "../../../problems/index.ts";
import {
  consumeDomainInvitation,
  createDomainInvitation,
  removeDomainMember,
  setMemberRoles,
} from "../../../access/workspace/index.ts";
import {
  createDomainSubmission,
  getDomainSubmission,
  listDomainSubmissions,
} from "../../index.ts";
import { fixture, withQueue } from "../_domain-execution-fixture.ts";
import { saveV2ResultForTest } from "../_versioning-fixtures.ts";

Deno.test({
  name: "域本人读取: 私有域排队活动不进入公开域提交长度与排位",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture();
    const invitation = await createDomainInvitation(
      f.source.slug,
      f.owner,
      `${f.student}@example.com`,
    );
    await consumeDomainInvitation(invitation.token, f.student);
    await withQueue(async () => {
      const own = await createDomainSubmission(
        f.source.slug,
        "1001",
        f.student,
        {
          language: "python3",
          code: "public",
          version_id: f.v2,
        },
      );
      await createDomainSubmission(f.a.slug, f.ref, f.student, {
        language: "python3",
        code: "private",
        version_id: f.v2,
      });
      const listed = await listDomainSubmissions(f.source.slug, f.student, {
        page: 1,
        perPage: 20,
      });
      assertEquals(listed.total, 1);
      assertEquals(listed.data[0].queue_length, null);
      assertEquals(listed.data[0].queue_position, null);
      const detail = await getDomainSubmission(
        f.source.slug,
        own.id,
        f.student,
      );
      assertEquals(detail.queue_length, null);
      assertEquals(detail.queue_position, null);
    });
  },
});

Deno.test({
  name: "域提交读取：错误域与同学被拒，撤销保留原代码成绩但删除源输出",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await withQueue(async () => {
      const created = await createDomainSubmission(f.a.slug, f.ref, f.student, {
        language: "python3",
        code: "print(42)",
        version_id: f.v2,
      });
      await saveV2ResultForTest({
        submission_id: created.id,
        status: "finished",
        score: 7000,
        output: "hidden evaluator output",
        details: { arbitrary: "source data" },
      });
      const detail = await getDomainSubmission(f.a.slug, created.id, f.student);
      assertEquals(detail.domain_id, f.a.id);
      assertEquals(detail.code, "print(42)");
      assertEquals(detail.resource_available, true);
      await assertRejects(
        () => getDomainSubmission(f.b.slug, created.id, f.student),
        NotFoundError,
      );
      await assertRejects(
        () => getDomainSubmission(f.a.slug, created.id, f.outsider),
        NotFoundError,
      );
      assertEquals(
        (await listDomainSubmissions(f.a.slug, f.student, {
          page: 1,
          perPage: 20,
        })).total,
        1,
      );
      assertEquals(
        (await listDomainSubmissions(f.b.slug, f.student, {
          page: 1,
          perPage: 20,
        })).total,
        0,
      );
      await setDomainProblemSharing(f.source.slug, "1001", f.owner, {
        expectedRevision: 1,
        enabled: false,
        scope: "all",
        targetDomainIds: [],
      });
      const withdrawn = await getDomainSubmission(
        f.a.slug,
        created.id,
        f.student,
      );
      assertEquals(withdrawn.code, "print(42)");
      assertEquals(withdrawn.resource_available, false);
      assertEquals(withdrawn.result, {
        status: "finished",
        score: 7000,
        time_ms: null,
        memory_kb: null,
      });
      assertEquals(Object.hasOwn(withdrawn, "attempts"), false);
      assertEquals(
        JSON.stringify(withdrawn).includes("hidden evaluator"),
        false,
      );
      assertEquals(JSON.stringify(withdrawn).includes("source data"), false);
      assertEquals(
        (await listDomainSubmissions(f.a.slug, f.student, {
          page: 1,
          perPage: 20,
        })).data[0].problem.title,
        "资源不可用",
      );
      await removeDomainMember(f.a.slug, f.owner, f.student);
      await assertRejects(
        () => getDomainSubmission(f.a.slug, created.id, f.student),
        NotFoundError,
      );
      const [stored] = await f.db.select().from(submissions).where(
        eq(submissions.id, created.id),
      );
      assertEquals(stored.code, "print(42)");
    });
  },
});
Deno.test({
  name: "域提交教师读取：当前同班学生可读，离职与离班撤权且历史另走作业依据",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture();
    const invite = await createDomainInvitation(
      f.a.slug,
      f.owner,
      `${f.outsider}@example.com`,
    );
    await consumeDomainInvitation(invite.token, f.outsider);
    const now = new Date().toISOString();
    await f.db.insert(classrooms).values({
      id: "submission-teacher-class",
      domain_id: f.a.id,
      name: "班级",
      created_at: now,
      updated_at: now,
    });
    await f.db.insert(classroomMemberships).values([
      {
        id: "submission-student",
        domain_id: f.a.id,
        classroom_id: "submission-teacher-class",
        user_id: f.student,
        role: "student",
        joined_at: now,
        appointed_at: now,
      },
    ]);
    await setMemberRoles(f.a.slug, f.owner, f.outsider, ["educator"]);
    await withQueue(async () => {
      const created = await createDomainSubmission(f.a.slug, f.ref, f.student, {
        language: "python3",
        code: "print('student')",
        version_id: f.v2,
      });
      assertEquals(
        (await getDomainSubmission(f.a.slug, created.id, f.outsider)).code,
        "print('student')",
      );
      await f.db.insert(contests).values({
        id: "teacher-kaggle",
        domain_id: f.a.id,
        title: "比赛",
        type: "kaggle",
        kind: "public",
        is_public: true,
        created_by: f.owner,
        start_time: new Date(Date.now() - 1000).toISOString(),
        end_time: new Date(Date.now() + 3600000).toISOString(),
        created_at: now,
        updated_at: now,
      });
      await f.db.insert(contestProblems).values({
        contest_id: "teacher-kaggle",
        domain_id: f.a.id,
        domain_problem_binding_id: f.bindingA.id,
        problem_id: f.problemId,
        label: "A",
        sort_order: 0,
        score: 100,
        pinned_version_id: f.v2,
      });
      await f.db.insert(contestParticipants).values({
        contest_id: "teacher-kaggle",
        user_id: f.student,
        registered_at: now,
      });
      await f.db.update(submissions).set({ contest_id: "teacher-kaggle" })
        .where(eq(submissions.id, created.id));
      assertEquals(
        (await getDomainSubmission(f.a.slug, created.id, f.student)).code,
        "print('student')",
      );
      assertEquals(
        (await getDomainSubmission(f.a.slug, created.id, f.outsider)).code,
        "print('student')",
      );
      await f.db.update(contests).set({
        start_time: new Date(Date.now() - 10000).toISOString(),
        end_time: new Date(Date.now() - 1000).toISOString(),
      }).where(eq(contests.id, "teacher-kaggle"));
      assertEquals(
        (await getDomainSubmission(f.a.slug, created.id, f.outsider)).code,
        "print('student')",
      );
      await setMemberRoles(f.a.slug, f.owner, f.outsider, ["member"]);
      const formerTeacher = await getDomainSubmission(
        f.a.slug,
        created.id,
        f.outsider,
      );
      assertEquals(formerTeacher.code, undefined);
      assertEquals(formerTeacher.can_view_source, false);
      await setMemberRoles(f.a.slug, f.owner, f.outsider, ["educator"]);
      await f.db.update(classroomMemberships).set({ status: "removed" }).where(
        eq(classroomMemberships.id, "submission-student"),
      );
      const formerStudent = await getDomainSubmission(
        f.a.slug,
        created.id,
        f.outsider,
      );
      assertEquals(formerStudent.code, undefined);
      assertEquals(formerStudent.can_view_source, false);
    });
  },
});
