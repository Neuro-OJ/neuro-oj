import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  classroomMemberships,
  classrooms,
  contestParticipants,
  contestProblems,
  contests,
  domainLimits,
  domainProblemBindings,
  evaluationAttempts,
  problems,
  problemVersions,
  submissions,
  trainingProblems,
  trainings,
  users,
} from "../../../../shared/db/schema.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  consumeDomainInvitation,
  createDomain,
  createDomainInvitation,
  removeDomainMember,
  setMemberRoles,
} from "../../../access/workspace/index.ts";
import { importDomainProblem } from "../../../problems/index.ts";

Deno.test({
  name: "域资源复制：题单及题目整体发布，额度失败整体回滚后可重试",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const source = await workspace("copy-training-source"),
      target = await workspace("copy-training-target");
    await join(source.domain.slug, source.owner, target.owner);
    await setMemberRoles(source.domain.slug, source.owner, target.owner, [
      "admin",
    ]);
    const first = await item(source.domain.id, source.owner, "objective", 1001),
      second = await item(source.domain.id, source.owner, "objective", 1002),
      trainingId = crypto.randomUUID(),
      now = new Date().toISOString(),
      db = getDb();
    await db.insert(trainings).values({
      id: trainingId,
      domain_id: source.domain.id,
      title: "可复制题单",
      state: "published",
      created_by: source.owner,
      created_at: now,
      updated_at: now,
    });
    await db.insert(trainingProblems).values([
      { training_id: trainingId, problem_id: first.id, position: 0 },
      { training_id: trainingId, problem_id: second.id, position: 1 },
    ]);
    await db.insert(domainLimits).values({
      domain_id: target.domain.id,
      problems: 1,
    })
      .onConflictDoUpdate({
        target: domainLimits.domain_id,
        set: { problems: 1 },
      });
    await assertRejects(() =>
      importDomainTraining(target.domain.slug, trainingId, target.owner)
    );
    assertEquals(
      (await db.select().from(problems).where(
        eq(problems.domain_id, target.domain.id),
      )).length,
      0,
    );
    assertEquals(
      (await db.select().from(trainings).where(
        eq(trainings.domain_id, target.domain.id),
      )).length,
      0,
    );
    await db.update(domainLimits).set({ problems: 5 }).where(
      eq(domainLimits.domain_id, target.domain.id),
    );
    const copied = await importDomainTraining(
      target.domain.slug,
      trainingId,
      target.owner,
    );
    assert(copied.training_id !== trainingId);
    await removeDomainMember(source.domain.slug, source.owner, target.owner);
    const detail = await readDomainTraining(
      target.domain.slug,
      copied.training_id,
      target.owner,
    );
    assertEquals(detail.state, "published");
    assertEquals(detail.items.length, 2);
    assert(
      detail.items.every((row) =>
        row.source_domain_id === target.domain.id && row.resource_available
      ),
    );
    assert(
      detail.items.every((row) =>
        row.problem_id !== first.id && row.problem_id !== second.id
      ),
    );
  },
});
import { importDomainTraining } from "../../../problems/services/workspace/training-sharing.ts";
import { readDomainTraining } from "../../../problems/services/workspace/training-access.ts";

Deno.test({
  name: "域赛题保护：赛前全版本、元数据、管理预览、重叠比赛与自动解除",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const a = await workspace("protection-school"), student = await account();
    await join(a.domain.slug, a.owner, student);
    const p = await item(a.domain.id, a.owner);
    const pending = await createDomainContest(
      a.domain.slug,
      a.owner,
      input(p.id),
    );
    assertEquals(pending.secrecy_enabled, true);
    for (const versionId of [p.v1, p.v2]) {
      const denied = await assertRejects(
        () =>
          resolveDomainProblem(a.domain.slug, "1001", student, { versionId }),
        ForbiddenError,
      );
      assertEquals(denied.code, "CONTEST_PROBLEM_RESTRICTED");
    }
    await resolveDomainProblem(a.domain.slug, "1001", a.owner);
    for (const user of [student, a.owner]) {
      await assertRejects(
        () => assertDomainPracticeAllowed(a.domain.id, p.id, user),
        ForbiddenError,
      );
      await assertRejects(
        () =>
          resolveDomainProblem(a.domain.slug, "1001", user, { write: true }),
        ForbiddenError,
      );
    }
    const listed = await listDomainProblems(a.domain.slug, student, {
      page: 1,
      limit: 20,
    });
    assertEquals(listed.items.length, 1);
    assertEquals(listed.items[0].can_practice, false);
    assertEquals(listed.items[0].contest_protection[0].contestId, pending.id);
    const summaries = await readDomainProblemSummaries(
      a.domain.slug,
      ["1001"],
      student,
    );
    assertEquals(summaries.items[0].availability, "available");
    assertEquals(summaries.items[0].can_read, false);
    await registerForDomainContest(a.domain.slug, pending.id, student);
    await assertRejects(
      () =>
        resolveDomainProblem(a.domain.slug, "1001", student, {
          contestId: pending.id,
        }),
      NotFoundError,
    );
    const active = await createDomainContest(
      a.domain.slug,
      a.owner,
      input(p.id, "ioi", true),
    );
    await registerForDomainContest(a.domain.slug, active.id, student);
    const admitted = await resolveDomainProblem(
      a.domain.slug,
      "1001",
      student,
      { contestId: active.id, write: true },
    );
    assertEquals(admitted.version.id, p.v1);
    await assertRejects(
      () =>
        updateDomainContest(
          a.domain.slug,
          active.id,
          a.owner,
          active.revision,
          { secrecy_enabled: false },
        ),
      ConflictError,
    );
    const past = new Date(Date.now() - 1000).toISOString();
    await getDb().update(contests).set({ end_time: past }).where(
      eq(contests.id, active.id),
    );
    await assertRejects(
      () => getDomainContestProblems(a.domain.slug, active.id, student),
      ForbiddenError,
    );
    await assertRejects(
      () => assertDomainPracticeAllowed(a.domain.id, p.id, student),
      ForbiddenError,
    );
    await getDb().update(contests).set({
      start_time: new Date(Date.now() - 60_000).toISOString(),
      end_time: past,
    }).where(eq(contests.id, pending.id));
    await resolveDomainProblem(a.domain.slug, "1001", student);
    await assertDomainPracticeAllowed(a.domain.id, p.id, student);
    await assertRejects(
      () =>
        resolveDomainProblem(a.domain.slug, "1001", student, {
          contestId: active.id,
          write: true,
        }),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "域赛题保护：关闭保护不再依赖邀请赛或公开赛标签",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const a = await workspace("protection-off"), student = await account();
    await join(a.domain.slug, a.owner, student);
    const p = await item(a.domain.id, a.owner);
    await createDomainContest(a.domain.slug, a.owner, {
      ...input(p.id),
      secrecy_enabled: false,
    });
    await resolveDomainProblem(a.domain.slug, "1001", student);
    await assertDomainPracticeAllowed(a.domain.id, p.id, student);
  },
});
import { resolveDomainProblem } from "../../../problems/services/workspace/problem-binding-access.ts";
import { listDomainProblems } from "../../../problems/services/workspace/problem-read.ts";
import { readDomainProblemSummaries } from "../../../problems/services/workspace/problem-summaries.ts";
import { assertDomainPracticeAllowed } from "../../services/practice-admission.ts";
import {
  addDomainContestParticipants,
  createDomainContest,
  getDomainContest,
  getDomainContestFinalRanking,
  getDomainContestProblems,
  getDomainContestRanking,
  getDomainContestSettlement,
  getDomainContestSubmissionTarget,
  listDomainContests,
  loadPublicContestSecrecy,
  publishDomainContestRanking,
  registerForDomainContest,
  resolveDefaultContestAccess,
  updateDomainContest,
} from "../../index.ts";

async function account() {
  const id = crypto.randomUUID(), now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: id,
    email: `${id}@example.com`,
    created_at: now,
    updated_at: now,
  });
  return id;
}
async function workspace(slug: string, preset: "team" | "community" = "team") {
  const owner = await account();
  const domain = await createDomain({ slug, name: slug, preset }, owner, {
    approved: true,
  });
  return { owner, domain };
}
async function join(slug: string, owner: string, user: string) {
  const invite = await createDomainInvitation(
    slug,
    owner,
    `${user}@example.com`,
  );
  await consumeDomainInvitation(invite.token, user);
}
async function item(
  domainId: string,
  owner: string,
  kind: "oi" | "ai" | "objective" = "oi",
  number = 1001,
) {
  const db = getDb(),
    id = crypto.randomUUID(),
    v1 = crypto.randomUUID(),
    v2 = crypto.randomUUID(),
    now = new Date().toISOString();
  await db.insert(problems).values({
    id,
    domain_id: domainId,
    number,
    title: kind,
    description: "statement",
    visibility: "public",
    judge_type: kind === "oi" ? "oi" : "dual",
    is_objective: kind === "objective",
    owner_id: owner,
    created_at: now,
    updated_at: now,
  });
  await db.insert(problemVersions).values([{
    id: v1,
    problem_id: id,
    version: 1,
    content: {
      kind,
      title: "固定题面",
      description: "v1",
      samples: [],
      ...(kind === "objective"
        ? {
          questions: [{
            key: "q",
            sort_order: 0,
            type: "single",
            prompt: "题干",
            options: [{ key: "A", text: "a" }],
            answer: ["A"],
            explanation: "",
          }],
        }
        : {}),
    },
    published_at: now,
  }, {
    id: v2,
    problem_id: id,
    version: 2,
    content: {
      kind,
      title: "新题面",
      description: "v2",
      samples: [],
      ...(kind === "objective"
        ? {
          questions: [{
            key: "q",
            sort_order: 0,
            type: "single",
            prompt: "新题干",
            options: [{ key: "A", text: "a" }],
            answer: ["A"],
            explanation: "",
          }],
        }
        : {}),
    },
    published_at: now,
  }]);
  await db.update(problems).set({ latest_version_id: v2 }).where(
    eq(problems.id, id),
  );
  const binding = crypto.randomUUID();
  await db.insert(domainProblemBindings).values({
    id: binding,
    domain_id: domainId,
    problem_id: id,
    kind: "owned",
    visibility: "public",
    created_by: owner,
    created_at: now,
    updated_at: now,
  });
  await db.update(problems).set({
    effective_version_mode: "exact",
    required_version_id: v1,
  }).where(eq(problems.id, id));
  return { id, v1, v2, binding };
}
function input(
  problemId: string,
  type: "oi" | "ioi" | "ioi_strict" | "acm" | "kaggle" = "ioi",
  running = false,
) {
  return {
    title: "域内比赛",
    type,
    start_time: new Date(Date.now() + (running ? -60_000 : 60_000))
      .toISOString(),
    end_time: new Date(Date.now() + 7_200_000).toISOString(),
    freeze_duration_seconds: 0,
    problems: [{
      problem_id: problemId,
      label: "A",
      sort_order: 0,
      score: 5000,
    }],
  };
}

Deno.test({
  name: "域比赛：目标域版本、复合绑定、跨域管理员和旧入口隔离",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const a = await workspace("contest-school-a"),
      b = await workspace("contest-school-b"),
      student = await account();
    await join(a.domain.slug, a.owner, student);
    const p = await item(a.domain.id, a.owner),
      other = await item(b.domain.id, b.owner);
    const contest = await createDomainContest(
      a.domain.slug,
      a.owner,
      input(p.id),
    );
    const [binding] = await getDb().select().from(contestProblems).where(
      eq(contestProblems.contest_id, contest.id),
    );
    assertEquals(binding.domain_id, a.domain.id);
    assertEquals(binding.domain_problem_binding_id, p.binding);
    assertEquals(binding.pinned_version_id, p.v1);
    assertEquals(
      (await getDomainContestProblems(a.domain.slug, contest.id, a.owner))[0]
        .title,
      "固定题面",
    );
    assertEquals(
      (await getDomainContestProblems(a.domain.slug, contest.id, a.owner))[0]
        .display_id,
      "1001",
    );
    await assertRejects(
      () => createDomainContest(a.domain.slug, a.owner, input(other.id)),
      NotFoundError,
    );
    await assertRejects(
      () => getDomainContest(b.domain.slug, contest.id, b.owner),
      NotFoundError,
    );
    await assertRejects(
      () => resolveDefaultContestAccess(contest.id, a.owner),
      NotFoundError,
    );
    await assertRejects(
      () => getDomainContestProblems(a.domain.slug, contest.id, student),
      ForbiddenError,
    );
    await registerForDomainContest(a.domain.slug, contest.public_id, student);
    const updated = await updateDomainContest(
      a.domain.slug,
      contest.id,
      a.owner,
      0,
      { title: "修改标题" },
    );
    assertEquals(updated.revision, 1);
    await assertRejects(
      () =>
        updateDomainContest(a.domain.slug, contest.id, a.owner, 0, {
          title: "覆盖",
        }),
      ConflictError,
    );
    await removeDomainMember(a.domain.slug, a.owner, student);
    await assertRejects(
      () => getDomainContest(a.domain.slug, contest.id, student),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "域比赛：赛题在赛前仅组织者、赛中仅参赛者、赛后对域内所有人开放",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const a = await workspace("contest-visibility"),
      student = await account();
    await join(a.domain.slug, a.owner, student);
    const p = await item(a.domain.id, a.owner);
    // 赛前：组织者可读，域员可读比赛但看不到赛题。
    const pending = await createDomainContest(
      a.domain.slug,
      a.owner,
      input(p.id),
    );
    assertEquals(
      (await getDomainContestProblems(a.domain.slug, pending.id, a.owner))
        .length,
      1,
    );
    await assertRejects(
      () => getDomainContestProblems(a.domain.slug, pending.id, student),
      ForbiddenError,
    );
    // 赛中未报名：仍然拒绝，避免赛题泄露给未报名者。
    const now = new Date();
    await getDb().update(contests).set({
      start_time: new Date(now.getTime() - 60_000).toISOString(),
      end_time: new Date(now.getTime() + 3_600_000).toISOString(),
    }).where(eq(contests.id, pending.id));
    await assertRejects(
      () => getDomainContestProblems(a.domain.slug, pending.id, student),
      ForbiddenError,
    );
    await registerForDomainContest(a.domain.slug, pending.id, student);
    assertEquals(
      (await getDomainContestProblems(a.domain.slug, pending.id, student))
        .length,
      1,
    );
    // 赛后：未报名（或退赛）的域员同样可以复盘赛题，但提交入口仍关闭。
    await getDb().update(contests).set({
      start_time: new Date(now.getTime() - 7_200_000).toISOString(),
      end_time: new Date(now.getTime() - 3_600_000).toISOString(),
    }).where(eq(contests.id, pending.id));
    await getDb().delete(contestParticipants).where(
      eq(contestParticipants.contest_id, pending.id),
    );
    assertEquals(
      (await getDomainContestProblems(a.domain.slug, pending.id, student))
        .length,
      1,
    );
    await assertRejects(
      () =>
        getDomainContestSubmissionTarget(
          a.domain.slug,
          pending.id,
          "A",
          student,
        ),
      ForbiddenError,
    );
  },
});

Deno.test({
  name: "域比赛：统一域内可见、报名不绕过域成员、组织角色撤销生效",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const a = await workspace("contest-private"),
      student = await account(),
      editor = await account(),
      outsider = await account();
    await join(a.domain.slug, a.owner, student);
    await join(a.domain.slug, a.owner, editor);
    await setMemberRoles(a.domain.slug, a.owner, editor, ["editor"]);
    const p = await item(a.domain.id, a.owner);
    const contest = await createDomainContest(a.domain.slug, editor, {
      ...input(p.id),
    });
    assertEquals(
      (await listDomainContests(a.domain.slug, student, {
        page: 1,
        perPage: 20,
      })).total,
      1,
    );
    await assertRejects(
      () => registerForDomainContest(a.domain.slug, contest.id, outsider),
      NotFoundError,
    );
    await registerForDomainContest(
      a.domain.slug,
      contest.id,
      student,
    );
    assertEquals(
      (await listDomainContests(a.domain.slug, student, {
        page: 1,
        perPage: 20,
      })).total,
      1,
    );
    await assertRejects(
      () =>
        addDomainContestParticipants(a.domain.slug, contest.id, a.owner, [
          outsider,
        ]),
      Error,
    );
    await setMemberRoles(a.domain.slug, a.owner, editor, ["member"]);
    await assertRejects(
      () => getDomainContestSettlement(a.domain.slug, contest.id, editor),
      ForbiddenError,
    );
    await assertRejects(
      () =>
        updateDomainContest(a.domain.slug, contest.id, editor, 0, {
          title: "越权",
        }),
      ForbiddenError,
    );
  },
});

Deno.test({
  name: "域比赛：独立复制不继承源保护，源域变化不会撤销目标副本",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const source = await workspace("contest-source", "community"),
      target = await workspace("contest-target"),
      p = await item(source.domain.id, source.owner, "objective");
    await assertRejects(
      () =>
        importDomainProblem(
          target.domain.slug,
          `${source.domain.slug}:1001`,
          target.owner,
        ),
      ForbiddenError,
    );
    await join(source.domain.slug, source.owner, target.owner);
    await setMemberRoles(source.domain.slug, source.owner, target.owner, [
      "admin",
    ]);
    const copied = await importDomainProblem(
      target.domain.slug,
      `${source.domain.slug}:1001`,
      target.owner,
      undefined,
      p.v1,
    );
    const copiedId = copied.binding.problem_id;
    assert(copiedId !== p.id);
    assertEquals(copied.binding.kind, "owned");
    const contest = await createDomainContest(
      target.domain.slug,
      target.owner,
      input(copiedId, "oi", true),
    );
    assertEquals(
      (await getDomainContestProblems(
        target.domain.slug,
        contest.id,
        target.owner,
      ))[0].display_id,
      String(copied.reference.number),
    );
    assertEquals(
      (await loadPublicContestSecrecy(p.id, getDb(), source.domain.id)).length,
      0,
    );
    assertEquals(
      (await loadPublicContestSecrecy(copiedId, getDb(), target.domain.id))
        .length,
      1,
    );
    await removeDomainMember(source.domain.slug, source.owner, target.owner);
    assertEquals(
      (await getDomainContestProblems(
        target.domain.slug,
        contest.id,
        target.owner,
      )).length,
      1,
    );
    await assertRejects(
      () => createDomainContest(target.domain.slug, target.owner, input(p.id)),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "域比赛：OI 赛时隐藏、IOI 全员榜、组织视图及正式快照保持",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const a = await workspace("contest-results"),
      first = await account(),
      second = await account();
    await join(a.domain.slug, a.owner, first);
    await join(a.domain.slug, a.owner, second);
    const p = await item(a.domain.id, a.owner);
    const oi = await createDomainContest(
      a.domain.slug,
      a.owner,
      input(p.id, "oi", true),
    );
    await addDomainContestParticipants(a.domain.slug, oi.id, a.owner, [
      first,
      second,
    ]);
    await assertRejects(
      () => getDomainContestRanking(a.domain.slug, oi.id, first),
      NotFoundError,
    );
    assertEquals(
      (await getDomainContestRanking(a.domain.slug, oi.id, a.owner)).rows
        .length,
      2,
    );
    const ioi = await createDomainContest(
      a.domain.slug,
      a.owner,
      input(p.id, "ioi", true),
    );
    await addDomainContestParticipants(a.domain.slug, ioi.id, a.owner, [
      first,
      second,
    ]);
    assertEquals(
      (await getDomainContestRanking(a.domain.slug, ioi.id, first)).rows.length,
      2,
    );
    await assertRejects(
      () =>
        updateDomainContest(a.domain.slug, ioi.id, a.owner, 0, {
          freeze_duration_seconds: 3600,
        }),
      ConflictError,
    );
    const now = new Date().toISOString(),
      id = crypto.randomUUID(),
      attempt = crypto.randomUUID();
    await getDb().insert(submissions).values({
      id,
      user_id: first,
      problem_id: p.id,
      domain_id: a.domain.id,
      domain_problem_binding_id: p.binding,
      contest_id: ioi.id,
      language: "cc",
      code: "code",
      status: "finished",
      submitted_version_id: p.v1,
      version_origin: "known",
      created_at: now,
    });
    await getDb().insert(evaluationAttempts).values({
      id: attempt,
      submission_id: id,
      problem_id: p.id,
      problem_version_id: p.v1,
      sequence: 0,
      source: "initial",
      state: "finished",
      result_kind: "graded",
      score: 10000,
      accepted: true,
      result_status: "AC",
      created_at: now,
    });
    await getDb().update(submissions).set({
      latest_attempt_id: attempt,
      contest_effective_attempt_id: attempt,
      is_contest_valid: true,
      is_contest_accepted: true,
    }).where(eq(submissions.id, id));
    await getDb().update(contests).set({
      end_time: new Date(Date.now() - 1).toISOString(),
    }).where(eq(contests.id, ioi.id));
    const published = await publishDomainContestRanking(
      a.domain.slug,
      ioi.id,
      a.owner,
      {},
    );
    assertEquals(
      published.rows.find((r) => r.user_id === first)!.total_score,
      5000,
    );
    await getDb().update(evaluationAttempts).set({
      score: 2000,
      accepted: false,
    }).where(eq(evaluationAttempts.id, attempt));
    assertEquals(
      (await getDomainContestFinalRanking(a.domain.slug, ioi.id, first)).data
        .find((r) => r.user_id === first)!.total_score,
      5000,
    );
    await assertRejects(
      () => publishDomainContestRanking(a.domain.slug, ioi.id, a.owner, {}),
      ConflictError,
    );
    const corrected = await publishDomainContestRanking(
      a.domain.slug,
      ioi.id,
      a.owner,
      { note: "重测更正" },
    );
    assertEquals(corrected.version, 2);
    assert(corrected.rows.find((r) => r.user_id === first)!.total_score < 5000);
  },
});

Deno.test({
  name: "班级竞赛发现：分页前筛选、跨班去重、域内统一可见及退班即时生效",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const a = await workspace("contest-class-discovery"),
      student = await account();
    await join(a.domain.slug, a.owner, student);
    const db = getDb(), now = new Date().toISOString();
    const rooms = [crypto.randomUUID(), crypto.randomUUID()];
    await db.insert(classrooms).values(rooms.map((id) => ({
      id,
      domain_id: a.domain.id,
      name: id,
      created_at: now,
      updated_at: now,
    })));
    await db.insert(classroomMemberships).values(rooms.map((classroom_id) => ({
      id: crypto.randomUUID(),
      domain_id: a.domain.id,
      classroom_id,
      user_id: student,
      role: "student" as const,
      joined_at: now,
      appointed_at: now,
    })));
    const p = await item(a.domain.id, a.owner);
    const _linked = await createDomainContest(a.domain.slug, a.owner, {
      ...input(p.id),
      classroom_ids: rooms,
    });
    await createDomainContest(a.domain.slug, a.owner, input(p.id));
    await createDomainContest(a.domain.slug, a.owner, {
      ...input(p.id),
      classroom_ids: rooms,
    });
    const query = { page: 1, perPage: 1, myClassrooms: true };
    const result = await listDomainContests(a.domain.slug, student, query);
    assertEquals(result.total, 2);
    assertEquals(result.data.length, 1);
    assertEquals(result.data[0].classrooms.length, 2);
    assertEquals(
      (await listDomainContests(a.domain.slug, student, {
        ...query,
        page: 2,
      })).data.length,
      1,
    );
    assertEquals(
      (await listDomainContests(a.domain.slug, student, {
        page: 1,
        perPage: 20,
        classroomId: rooms[0],
      })).total,
      2,
    );
    assertEquals(
      (await listDomainContests(a.domain.slug, student, {
        page: 1,
        perPage: 20,
        classroomId: "foreign-classroom",
      })).total,
      0,
    );
    assertEquals(
      (await listDomainContests(a.domain.slug, a.owner, query)).total,
      0,
    );
    await db.update(classroomMemberships).set({ status: "removed" }).where(
      eq(classroomMemberships.user_id, student),
    );
    assertEquals(
      (await listDomainContests(a.domain.slug, student, query)).total,
      0,
    );
  },
});
