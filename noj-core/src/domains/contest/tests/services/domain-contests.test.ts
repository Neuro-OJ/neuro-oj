import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  contestProblems,
  contests,
  domainProblemBindings,
  evaluationAttempts,
  problems,
  problemShareSettings,
  problemVersions,
  submissions,
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
  transferDomain,
} from "../../../workspace/index.ts";
import { importDomainProblem } from "../../../catalog/index.ts";
import {
  addDomainContestParticipants,
  createDomainContest,
  getDomainContest,
  getDomainContestFinalRanking,
  getDomainContestProblems,
  getDomainContestRanking,
  getDomainContestSettlement,
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
    content: { kind, title: "固定题面", description: "v1" },
    published_at: now,
  }, {
    id: v2,
    problem_id: id,
    version: 2,
    content: { kind, title: "新题面", description: "v2" },
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
    effective_version_mode: "exact",
    required_version_id: v1,
    created_by: owner,
    created_at: now,
    updated_at: now,
  });
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
  name: "域比赛：报名不绕过域成员、邀请赛仅授权可见、组织角色撤销生效",
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
    await transferDomain(a.domain.slug, a.owner, editor);
    const p = await item(a.domain.id, a.owner);
    const contest = await createDomainContest(a.domain.slug, editor, {
      ...input(p.id),
      kind: "invite",
      password: "secret",
    });
    assertEquals(
      (await listDomainContests(a.domain.slug, student, {
        page: 1,
        perPage: 20,
      })).total,
      0,
    );
    await assertRejects(
      () =>
        registerForDomainContest(a.domain.slug, contest.id, outsider, "secret"),
      NotFoundError,
    );
    await assertRejects(
      () =>
        registerForDomainContest(a.domain.slug, contest.id, student, "wrong"),
      ForbiddenError,
    );
    await registerForDomainContest(
      a.domain.slug,
      contest.id,
      student,
      "secret",
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
    await transferDomain(a.domain.slug, editor, a.owner);
    await assertRejects(
      () => getDomainContestSettlement(a.domain.slug, contest.id, editor),
      NotFoundError,
    );
    await assertRejects(
      () =>
        updateDomainContest(a.domain.slug, contest.id, editor, 0, {
          title: "越权",
        }),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "域比赛：引用源题号、源共享即时撤销及其他域比赛不扩大保密",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const source = await workspace("contest-source", "community"),
      target = await workspace("contest-target"),
      p = await item(source.domain.id, source.owner);
    await getDb().insert(problemShareSettings).values({
      problem_id: p.id,
      enabled: true,
      scope: "all",
      updated_by: source.owner,
      updated_at: new Date().toISOString(),
    });
    await importDomainProblem(
      target.domain.slug,
      `${source.domain.slug}:1001`,
      target.owner,
    );
    const contest = await createDomainContest(
      target.domain.slug,
      target.owner,
      input(p.id, "ioi", true),
    );
    assertEquals(
      (await getDomainContestProblems(
        target.domain.slug,
        contest.id,
        target.owner,
      ))[0].display_id,
      "contest-source:1001",
    );
    assertEquals(
      (await loadPublicContestSecrecy(p.id, getDb(), source.domain.id)).length,
      0,
    );
    assertEquals(
      (await loadPublicContestSecrecy(p.id, getDb(), target.domain.id)).length,
      1,
    );
    await getDb().update(problemShareSettings).set({ enabled: false }).where(
      eq(problemShareSettings.problem_id, p.id),
    );
    await assertRejects(
      () =>
        getDomainContestProblems(target.domain.slug, contest.id, target.owner),
      NotFoundError,
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
