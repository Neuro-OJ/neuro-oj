import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  domainProblemBindings,
  objectiveSubmissions,
  problems,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import {
  consumeDomainInvitation,
  createDomainInvitation,
} from "../../../workspace/index.ts";
import {
  createDomainSubmission,
  getDomainObjectiveSubmissionHistory,
  getDomainSubmission,
  getQueueOverview,
  listDomainSubmissions,
} from "../../index.ts";
import { fixture, withQueue } from "../_domain-execution-fixture.ts";

Deno.test({
  name: "统一域提交：全题型分页、用户名与查看者隔离、他人只读摘要及跨域拒绝",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture();
    const invite = await createDomainInvitation(
      f.a.slug,
      f.owner,
      `${f.outsider}@example.com`,
    );
    await consumeDomainInvitation(invite.code, f.outsider);
    await withQueue(async () => {
      await createDomainSubmission(f.a.slug, f.ref, f.student, {
        language: "python3",
        code: "mine",
        version_id: f.v2,
      });
      const other = await createDomainSubmission(f.a.slug, f.ref, f.outsider, {
        language: "python3",
        code: "private source",
        version_id: f.v2,
      });
      await createDomainSubmission(f.b.slug, f.ref, f.student, {
        language: "python3",
        code: "other domain",
        version_id: f.v2,
      });
      const now = new Date().toISOString(),
        paper = "unified-paper",
        version = "unified-version",
        binding = "unified-binding";
      await f.db.insert(problems).values({
        id: paper,
        domain_id: f.a.id,
        number: 1001,
        title: "客观卷",
        description: "",
        is_objective: true,
        owner_id: f.owner,
        created_at: now,
        updated_at: now,
      });
      await f.db.insert(problemVersions).values({
        id: version,
        problem_id: paper,
        version: 1,
        content: {},
        published_at: now,
      });
      await f.db.update(problems).set({ latest_version_id: version }).where(
        eq(problems.id, paper),
      );
      await f.db.insert(domainProblemBindings).values({
        id: binding,
        domain_id: f.a.id,
        problem_id: paper,
        kind: "owned",
        visibility: "members",
        created_by: f.owner,
        created_at: now,
        updated_at: now,
      });
      await f.db.insert(objectiveSubmissions).values({
        id: "unified-answer",
        domain_id: f.a.id,
        domain_problem_binding_id: binding,
        paper_id: paper,
        user_id: f.outsider,
        submission_type: "practice",
        submitted_version_id: version,
        version_origin: "known",
        answers: { q: ["secret"] },
        created_at: now,
      });
      assertEquals(
        (await listDomainSubmissions(f.a.slug, f.student, {
          page: 1,
          perPage: 20,
        })).total,
        1,
      );
      const all = await listDomainSubmissions(f.a.slug, f.student, {
        page: 1,
        perPage: 2,
        username: "",
      });
      assertEquals(all.total, 3);
      assertEquals(all.data.length, 2);
      assertEquals(
        all.data.every((row) =>
          row.code === undefined && row.answers === undefined
        ),
        true,
      );
      const otherRows = await listDomainSubmissions(f.a.slug, f.student, {
        page: 1,
        perPage: 20,
        username: f.outsider,
      });
      assertEquals(otherRows.total, 2);
      assertEquals(
        (await listDomainSubmissions(f.a.slug, f.student, {
          page: 1,
          perPage: 20,
          username: "missing-user",
        })).total,
        0,
      );
      const summary = await getDomainSubmission(f.a.slug, other.id, f.student);
      assertEquals(summary.code, undefined);
      assertEquals(summary.can_view_source, false);
      const objective = await getDomainObjectiveSubmissionHistory(
        f.a.slug,
        f.student,
        "unified-answer",
      );
      assertEquals(objective.answers, undefined);
      assertEquals(objective.can_view_answers, false);
      assertEquals(
        (await getDomainObjectiveSubmissionHistory(
          f.a.slug,
          f.outsider,
          "unified-answer",
        )).answers,
        { q: ["secret"] },
      );
      await assertRejects(() =>
        getDomainObjectiveSubmissionHistory(
          f.b.slug,
          f.student,
          "unified-answer",
        ), NotFoundError);
    });
  },
});

Deno.test({
  name: "实例队列：全局计数保留私有负载，任务明细只包含可进入域",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture();
    await withQueue(async () => {
      const own = await createDomainSubmission(f.a.slug, f.ref, f.student, {
        language: "python3",
        code: "own",
        version_id: f.v2,
      });
      await createDomainSubmission(f.b.slug, f.ref, f.student, {
        language: "python3",
        code: "hidden",
        version_id: f.v2,
      });
      const mine = await getQueueOverview(false, f.student, {
        domainId: f.a.id,
        member: true,
      });
      assertEquals(mine.judging.some((row) => row.id === own.id), true);
      const outsider = await getQueueOverview(false, f.outsider, {
        domainId: "",
        member: false,
        instance: true,
        viewerId: f.outsider,
      });
      assertEquals(outsider.stats.judging_count, 2);
      assertEquals(outsider.judging.length, 0);
      const member = await getQueueOverview(false, f.student, {
        domainId: "",
        member: false,
        instance: true,
        viewerId: f.student,
      });
      assertEquals(member.judging.length, 2);
      assertEquals(
        member.judging.every((row) =>
          [f.a.slug, f.b.slug].includes(row.domain_slug!)
        ),
        true,
      );
    });
  },
});
