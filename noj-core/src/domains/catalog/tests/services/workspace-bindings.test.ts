import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  contests,
  domainLimits,
  domainProblemBindings,
  domainResourceCounters,
  domains,
  evaluationAttempts,
  objectiveSubmissions,
  problemBindingHistory,
  problems,
  problemTags,
  problemVersions,
  roles,
  submissions,
  tags,
  trainings,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import {
  recomputeProblemProjections,
  recomputeSubmissionProjection,
  upsertCurrentVersionResult,
} from "../../../submission/index.ts";
import {
  consumeDomainInvitation,
  createDomain,
  createDomainInvitation,
  DEFAULT_DOMAIN_ID,
  ensureDefaultWorkspace,
  removeDomainMember,
  setDomainStatus,
  setMemberRoles,
  updateDomain,
} from "../../../workspace/index.ts";
import { backfillDefaultCatalog } from "../../services/workspace/backfill.ts";
import { resolveDomainProblem } from "../../services/workspace/problem-binding-access.ts";
import {
  importDomainProblem,
  setDomainProblemBindingPolicy,
} from "../../services/workspace/problem-bindings.ts";
import { setDomainProblemSharing } from "../../services/workspace/problem-sharing.ts";
import {
  listDomainProblems,
  listDomainProblemVersions,
  readDomainProblem,
  readDomainProblemTemplate,
} from "../../services/workspace/problem-read.ts";

Deno.test("域作答附件：模板跟随目标版本且冲突保留确认，版本目录不返回配置", async () => {
  const f = await fixture(), reference = "public-source:1001";
  await importDomainProblem(f.school.slug, reference, f.teacher);
  const read = await readDomainProblem(f.school.slug, reference, f.student);
  assertEquals(read.supported_languages, ["python3"]);
  assertEquals(
    (await readDomainProblemTemplate(
      f.school.slug,
      reference,
      f.student,
      f.versions[1],
    )).template_content,
    "print('template')",
  );
  const mismatch = await assertRejects(
    () =>
      readDomainProblemTemplate(
        f.school.slug,
        reference,
        f.student,
        f.versions[0],
      ),
    AppError,
  );
  assertEquals(mismatch.code, "PROBLEM_ANSWER_VERSION_CHANGED");
  const versions = await listDomainProblemVersions(
    f.school.slug,
    reference,
    f.student,
    1,
    1,
  );
  assertEquals(versions.items.length, 1);
  assertEquals(versions.total, 2);
  assertEquals(versions.answer_version_id, f.versions[1]);
  assertEquals(Object.hasOwn(versions.items[0], "content"), false);
  await setDomainProblemSharing(f.source.slug, "1001", f.platform, {
    expectedRevision: 1,
    enabled: false,
    scope: "all",
    targetDomainIds: [],
  });
  await assertRejects(
    () => readDomainProblemTemplate(f.school.slug, reference, f.student),
    NotFoundError,
  );
  await assertRejects(
    () => listDomainProblemVersions(f.school.slug, reference, f.student, 1, 20),
    NotFoundError,
  );
});

async function account(admin = false) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: id,
    email: `${id}@example.com`,
    created_at: now,
    updated_at: now,
  });
  if (admin) {
    const [role] = await getDb().select().from(roles).where(
      eq(roles.name, "admin"),
    );
    await getDb().insert(userRoles).values({ user_id: id, role_id: role.id });
  }
  return id;
}

async function fixture() {
  await resetDbForTest();
  const platform = await account(true);
  await ensureDefaultWorkspace();
  const source = await createDomain({
    slug: "public-source",
    name: "公开题库",
    preset: "community",
  }, platform);
  const school = await createDomain({
    slug: "school-one",
    name: "学校一",
    preset: "education",
  }, platform);
  const other = await createDomain({
    slug: "school-two",
    name: "学校二",
    preset: "education",
  }, platform);
  const teacher = await account();
  const student = await account();
  for (const id of [teacher, student]) {
    const invite = await createDomainInvitation(
      school.slug,
      platform,
      `${id}@example.com`,
    );
    await consumeDomainInvitation(invite.token, id);
  }
  await setMemberRoles(school.slug, platform, teacher, ["admin"]);
  const now = new Date().toISOString();
  const problem = crypto.randomUUID();
  const second = crypto.randomUUID();
  await getDb().insert(problems).values(
    [problem, second].map((id, i) => ({
      id,
      domain_id: source.id,
      number: 1001 + i,
      title: "公开源题",
      description: "题面",
      owner_id: platform,
      created_at: now,
      updated_at: now,
    })),
  );
  const versions = [
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
  ];
  await getDb().insert(problemVersions).values(
    versions.map((id, i) => ({
      id,
      problem_id: i === 2 ? second : problem,
      version: i === 1 ? 2 : 1,
      content: {
        kind: "ai",
        title: `V${i}`,
        description: "不可变内容",
        runtime_config: {
          evaluator: {
            image: "noj-evaluator-python",
            command: "python3 evaluate.py",
          },
          solution: { image: "noj-solution-python" },
        },
        llm_config: { max_calls: 5 },
        template_content: "print('template')",
      },
      published_at: now,
    })),
  );
  for (const [id, latest] of [[problem, versions[1]], [second, versions[2]]]) {
    await getDb().update(problems).set({ latest_version_id: latest }).where(
      eq(problems.id, id),
    );
    await getDb().insert(domainProblemBindings).values({
      id: crypto.randomUUID(),
      domain_id: source.id,
      problem_id: id,
      kind: "owned",
      visibility: "public",
      created_by: platform,
      created_at: now,
      updated_at: now,
    });
    await setDomainProblemSharing(
      source.slug,
      `public-source:${id === problem ? 1001 : 1002}`,
      platform,
      { expectedRevision: 0, enabled: true, scope: "all", targetDomainIds: [] },
    );
  }
  return {
    platform,
    teacher,
    student,
    source,
    school,
    other,
    problem,
    second,
    versions,
  };
}

Deno.test("默认域绑定补齐：合法来源保留 ID、版本、题号和策略，重复运行不覆盖绑定", async () => {
  await resetDbForTest();
  await ensureDefaultWorkspace();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const version = crypto.randomUUID();
  await getDb().insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id,
    number: 4321,
    title: "旧题",
    description: "题面",
    created_at: now,
    updated_at: now,
  });
  await getDb().insert(problemVersions).values({
    id: version,
    problem_id: id,
    version: 1,
    content: {},
    published_at: now,
  });
  await getDb().update(problems).set({
    latest_version_id: version,
    effective_version_mode: "exact",
    required_version_id: version,
    effective_policy_revision: 3,
  }).where(eq(problems.id, id));
  await getDb().insert(trainings).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id: crypto.randomUUID(),
    title: "旧题单",
    created_by: "0",
    created_at: now,
    updated_at: now,
  });
  assertEquals(await backfillDefaultCatalog(), {
    problems_assigned: 0,
    trainings_assigned: 0,
    bindings_created: 1,
  });
  const [binding] = await getDb().select().from(domainProblemBindings);
  assertEquals(binding.required_version_id, version);
  assertEquals(binding.revision, 3);
  await getDb().update(domainProblemBindings).set({
    effective_version_mode: "any",
    required_version_id: null,
    revision: 4,
  }).where(eq(domainProblemBindings.id, binding.id));
  assertEquals(await backfillDefaultCatalog(), {
    problems_assigned: 0,
    trainings_assigned: 0,
    bindings_created: 0,
  });
  const [again] = await getDb().select().from(domainProblemBindings);
  assertEquals(again.revision, 4);
  assertEquals(again.effective_version_mode, "any");
  const [source] = await getDb().select().from(problems).where(
    eq(problems.id, id),
  );
  assertEquals(source.domain_id, DEFAULT_DOMAIN_ID);
  assertEquals(source.number, 4321);
  assertEquals(source.latest_version_id, version);
  const [domain] = await getDb().select().from(domains).where(
    eq(domains.id, DEFAULT_DOMAIN_ID),
  );
  assertEquals(domain.next_problem_number, 4322);
  assertEquals((await getDb().select().from(problemBindingHistory)).length, 1);
});

Deno.test("域题库读取：分页计数先授权，exact 题面及来源题号保持目标域口径", async () => {
  const f = await fixture();
  const imported = await importDomainProblem(
    f.school.slug,
    "public-source:1001",
    f.teacher,
  );
  await importDomainProblem(f.school.slug, "public-source:1002", f.teacher);
  await setDomainProblemBindingPolicy(
    f.school.slug,
    "public-source:1001",
    f.teacher,
    imported.binding.revision,
    { mode: "exact", version_id: f.versions[0] },
    "使用初版",
  );
  const page = await listDomainProblems(f.school.slug, f.student, {
    page: 1,
    limit: 1,
  });
  assertEquals(page.total, 2);
  assertEquals(page.items.length, 1);
  assertEquals(page.items[0].reference.display_ref, "public-source:1001");
  assertEquals(page.items[0].title, "V0");
  const detail = await readDomainProblem(
    f.school.slug,
    "public-source:1001",
    f.teacher,
  );
  assertEquals(detail.can_edit, false);
  assertEquals(detail.content.title, "V0");
  assertEquals("runtime_config" in detail.content, false);
  assertEquals("llm_config" in detail.content, false);
  await assertRejects(
    () => readDomainProblem(f.other.slug, "public-source:1001", f.student),
    NotFoundError,
  );
});

Deno.test("域题库读取：源题撤销同时移除列表、命中数和题面", async () => {
  const f = await fixture();
  await importDomainProblem(f.school.slug, "public-source:1001", f.teacher);
  await importDomainProblem(f.school.slug, "public-source:1002", f.teacher);
  await setDomainProblemSharing(f.source.slug, "1001", f.platform, {
    expectedRevision: 1,
    enabled: false,
    scope: "all",
    targetDomainIds: [],
  });
  const page = await listDomainProblems(f.school.slug, f.teacher, {
    page: 1,
    limit: 20,
  });
  assertEquals(page.total, 1);
  assertEquals(page.items[0].reference.display_ref, "public-source:1002");
  assertEquals(
    (await listDomainProblems(f.school.slug, f.teacher, {
      page: 1,
      limit: 20,
      keyword: "V1",
    })).total,
    0,
  );
  await assertRejects(
    () => readDomainProblem(f.school.slug, "public-source:1001", f.platform),
    NotFoundError,
  );
});

Deno.test("域题库筛选：题号、难度、本人状态、隐藏算法标签及比赛结果均按使用域计数", async () => {
  const f = await fixture(), db = getDb(), now = new Date().toISOString();
  const first = await importDomainProblem(
    f.school.slug,
    "public-source:1001",
    f.teacher,
  );
  await importDomainProblem(f.school.slug, "public-source:1002", f.teacher);
  const other = await importDomainProblem(
    f.other.slug,
    "public-source:1001",
    f.platform,
  );
  const topic = crypto.randomUUID(), algorithm = crypto.randomUUID();
  await db.insert(tags).values([{
    id: topic,
    name: "题型标签",
    kind: "problem",
    created_at: now,
    updated_at: now,
  }, {
    id: algorithm,
    name: "隐藏算法",
    kind: "algorithm",
    created_at: now,
    updated_at: now,
  }]);
  await db.insert(problemTags).values([
    { problem_id: f.problem, tag_id: topic },
    { problem_id: f.problem, tag_id: algorithm },
  ]);
  await db.insert(submissions).values({
    id: crypto.randomUUID(),
    domain_id: f.other.id,
    domain_problem_binding_id: other.binding.id,
    user_id: f.student,
    problem_id: f.problem,
    language: "python3",
    code: "other domain AC",
    is_valid: true,
    is_accepted: true,
    created_at: now,
  });
  const read = (
    query: {
      keyword?: string;
      difficulty?: string;
      progress?: string;
      tag_id?: string;
      judge_backend?: string;
    } = {},
  ) =>
    listDomainProblems(f.school.slug, f.student, {
      page: 1,
      limit: 1,
      ...query,
    });
  for (const keyword of ["1001", "public-source:1001", "V1"]) {
    const page = await read({ keyword });
    assertEquals(page.total, 1);
    assertEquals(page.items[0].reference.display_ref, "public-source:1001");
  }
  const initialPage = await read();
  const initial = initialPage.items[0];
  assertEquals(initialPage.tags.map((tag) => tag.id), [topic]);
  assertEquals(initial.judge_backend, "dual");
  assertEquals(Object.keys(initial.limits!).sort(), [
    "memory_limit_mb",
    "time_limit_ms",
  ]);
  assertEquals((await read({ judge_backend: "dual" })).total, 2);
  assertEquals((await read({ judge_backend: "oi-native" })).total, 0);
  assertEquals(initial.progress, "unseen");
  assertEquals(initial.submit_count, 0);
  assertEquals(initial.tags.map((t) => t.id), [topic]);
  assertEquals(initial.has_hidden_algorithm_tags, true);
  assertEquals((await read({ tag_id: algorithm })).total, 0);
  assertEquals((await read({ tag_id: topic })).total, 1);
  assertEquals((await read({ progress: "solved" })).total, 0);
  assertEquals((await read({ progress: "unseen" })).total, 2);
  assertEquals((await read({ difficulty: "hard" })).total, 0);
  await db.insert(contests).values({
    id: "list-hidden-contest",
    domain_id: f.school.id,
    title: "隐藏成绩",
    created_by: f.teacher,
    type: "oi",
    kind: "invite",
    description: "",
    start_time: new Date(Date.now() - 60000).toISOString(),
    end_time: new Date(Date.now() + 60000).toISOString(),
    created_at: now,
    updated_at: now,
  });
  await db.insert(submissions).values({
    id: crypto.randomUUID(),
    domain_id: f.school.id,
    domain_problem_binding_id: first.binding.id,
    user_id: f.student,
    problem_id: f.problem,
    contest_id: "list-hidden-contest",
    language: "python3",
    code: "hidden AC",
    is_valid: true,
    is_accepted: true,
    created_at: now,
  });
  assertEquals((await read({ progress: "solved" })).total, 0);
  assertEquals((await read()).items[0].submit_count, 0);
  const hiddenDetail = await readDomainProblem(
    f.school.slug,
    "public-source:1001",
    f.student,
  );
  assertEquals(hiddenDetail.statistics.submit_count, 0);
  assertEquals(hiddenDetail.statistics.progress, "unseen");
  await db.update(contests).set({
    end_time: new Date(Date.now() - 1000).toISOString(),
  }).where(eq(contests.id, "list-hidden-contest"));
  const solved = await read({ progress: "solved", tag_id: algorithm });
  assertEquals(solved.total, 1);
  assertEquals(solved.items[0].progress, "solved");
  assertEquals(solved.items[0].accepted_submissions, 1);
  const endedDetail = await readDomainProblem(
    f.school.slug,
    "public-source:1001",
    f.student,
  );
  assertEquals(endedDetail.statistics.accepted_submissions, 1);
  assertEquals(endedDetail.statistics.progress, "solved");
  assertEquals(solved.items[0].tags.length, 2);
  assertEquals(solved.tags.length, 2);
  assertEquals((await read({ progress: "unseen" })).total, 1);
});

Deno.test("默认域绑定补齐：两道合法来源题独立建绑定，重复执行不重复绑定", async () => {
  await resetDbForTest();
  await ensureDefaultWorkspace();
  const now = new Date().toISOString();
  const ids: string[] = [crypto.randomUUID(), crypto.randomUUID()];
  await getDb().insert(problems).values(
    ids.map((id, i) => ({
      domain_id: DEFAULT_DOMAIN_ID,
      id,
      number: 1001 + i,
      title: "旧题",
      description: "题面",
      created_at: now,
      updated_at: now,
    })),
  );
  assertEquals(await backfillDefaultCatalog(), {
    problems_assigned: 0,
    trainings_assigned: 0,
    bindings_created: 2,
  });
  assertEquals(
    (await getDb().select().from(problems)).every((p) =>
      p.domain_id === DEFAULT_DOMAIN_ID && ids.includes(p.id)
    ),
    true,
  );
  assertEquals(await backfillDefaultCatalog(), {
    problems_assigned: 0,
    trainings_assigned: 0,
    bindings_created: 0,
  });
  assertEquals((await getDb().select().from(domainProblemBindings)).length, 2);
});

Deno.test("域成绩：策略切换即时重算本绑定，重测和源域批量重算不串域", async () => {
  const f = await fixture(), db = getDb();
  const school = await importDomainProblem(
    f.school.slug,
    "public-source:1001",
    f.teacher,
  );
  const other = await importDomainProblem(
    f.other.slug,
    "public-source:1001",
    f.platform,
  );
  const now = new Date().toISOString();
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  await db.insert(submissions).values({
    id: ids[0],
    domain_id: f.school.id,
    domain_problem_binding_id: school.binding.id,
    user_id: f.student,
    problem_id: school.binding.problem_id,
    language: "python3",
    code: "original",
    version_origin: "known",
    submitted_version_id: f.versions[0],
    created_at: now,
  });
  await db.insert(objectiveSubmissions).values({
    id: ids[1],
    domain_id: f.other.id,
    domain_problem_binding_id: other.binding.id,
    user_id: f.student,
    paper_id: school.binding.problem_id,
    answers: {},
    submission_type: "practice",
    version_origin: "known",
    submitted_version_id: f.versions[0],
    created_at: now,
  });
  const sources = ids.map((id, i) => ({
    kind: i ? "objective" as const : "submission" as const,
    id,
    problem_id: school.binding.problem_id,
  }));
  const score = async (attemptId: string | null) => {
    const [row] = await db.select({ score: evaluationAttempts.score }).from(
      evaluationAttempts,
    )
      .where(eq(evaluationAttempts.id, attemptId!));
    return row.score;
  };
  const attempts: string[][] = [[], []];
  for (const [i, source] of sources.entries()) {
    for (let v = 0; v < 2; v++) {
      const attempt = crypto.randomUUID();
      attempts[i].push(attempt);
      await db.insert(evaluationAttempts).values({
        id: attempt,
        submission_id: i ? null : source.id,
        objective_submission_id: i ? source.id : null,
        problem_id: source.problem_id,
        problem_version_id: f.versions[v],
        sequence: v,
        source: "initial",
        state: "finished",
        result_kind: "graded",
        result_status: "finished",
        score: v ? 2000 : 10000,
        accepted: !v,
        created_at: now,
      });
      await upsertCurrentVersionResult(db, {
        source,
        problemVersionId: f.versions[v],
        attemptId: attempt,
      });
    }
    await recomputeSubmissionProjection(db, source);
  }
  await setDomainProblemBindingPolicy(
    f.school.slug,
    "public-source:1001",
    f.teacher,
    0,
    { mode: "exact", version_id: f.versions[1] },
    "学校仅接受 V2",
  );
  const [plain] = await db.select().from(submissions).where(
    eq(submissions.id, ids[0]),
  );
  const [objective] = await db.select().from(objectiveSubmissions).where(
    eq(objectiveSubmissions.id, ids[1]),
  );
  assertEquals(await score(plain.effective_attempt_id), 2000);
  assertEquals(plain.is_accepted, false);
  assertEquals(plain.global_policy_revision, 1);
  assertEquals(plain.effective_attempt_id, attempts[0][1]);
  assertEquals(plain.code, "original");
  assertEquals(plain.created_at, now);
  assertEquals(await score(objective.effective_attempt_id), 10000);
  assertEquals(objective.global_policy_revision, 0);
  // 源题策略改动和整题重算仍分别使用每条提交所属域的绑定。
  await setDomainProblemBindingPolicy(f.source.slug, "1001", f.platform, 0, {
    mode: "exact",
    version_id: f.versions[1],
  }, "源域切换");
  await recomputeProblemProjections(db, school.binding.problem_id);
  assertEquals(
    await score(
      (await db.select().from(objectiveSubmissions).where(
        eq(objectiveSubmissions.id, ids[1]),
      ))[0].effective_attempt_id,
    ),
    10000,
  );
  // V2 重测降低成绩，只影响该提交；策略 revision 不变。
  const replacement = crypto.randomUUID();
  await db.insert(evaluationAttempts).values({
    id: replacement,
    submission_id: ids[0],
    problem_id: school.binding.problem_id,
    problem_version_id: f.versions[1],
    sequence: 2,
    source: "rejudge",
    state: "finished",
    result_kind: "graded",
    result_status: "finished",
    score: 500,
    accepted: false,
    created_at: now,
  });
  await upsertCurrentVersionResult(db, {
    source: sources[0],
    problemVersionId: f.versions[1],
    attemptId: replacement,
  });
  await recomputeSubmissionProjection(db, sources[0]);
  assertEquals(
    await score(
      (await db.select().from(submissions).where(eq(submissions.id, ids[0])))[0]
        .effective_attempt_id,
    ),
    500,
  );
  await setDomainProblemBindingPolicy(
    f.school.slug,
    "public-source:1001",
    f.teacher,
    1,
    { mode: "any" },
    "恢复全部版本",
  );
  assertEquals(
    await score(
      (await db.select().from(submissions).where(eq(submissions.id, ids[0])))[0]
        .effective_attempt_id,
    ),
    10000,
  );
});

Deno.test("域绑定：批量任务策略变更与历史依据服从调用方事务回滚", async () => {
  const f = await fixture();
  const imported = await importDomainProblem(
    f.school.slug,
    "public-source:1001",
    f.teacher,
  );
  const db = getDb();
  const before = await db.select().from(problemBindingHistory).where(
    eq(problemBindingHistory.binding_id, imported.binding.id),
  );
  await assertRejects(
    () =>
      db.transaction(async (tx) => {
        await setDomainProblemBindingPolicy(
          f.school.slug,
          "public-source:1001",
          f.teacher,
          0,
          { mode: "exact", version_id: f.versions[0] },
          "批量任务策略",
          tx,
        );
        throw new Error("任务创建失败");
      }),
    Error,
    "任务创建失败",
  );
  const resource = await resolveDomainProblem(
    f.school.slug,
    "public-source:1001",
    f.student,
  );
  assertEquals(resource.binding.revision, 0);
  assertEquals(resource.binding.effective_version_mode, "any");
  assertEquals(resource.version.id, f.versions[1]);
  assertEquals(
    await db.select().from(problemBindingHistory).where(
      eq(problemBindingHistory.binding_id, imported.binding.id),
    ),
    before,
  );
});

Deno.test("域绑定：来源题号、策略独立、默认版本切换与 revision 沿革", async () => {
  const f = await fixture();
  await setDomainProblemBindingPolicy(f.source.slug, "1001", f.platform, 0, {
    mode: "exact",
    version_id: f.versions[0],
  }, "源域要求 V1");
  const imported = await importDomainProblem(
    f.school.slug,
    "public-source:1001",
    f.teacher,
  );
  assertEquals(imported.reference.display_ref, "public-source:1001");
  assertEquals(imported.binding.required_version_id, f.versions[0]);
  await setDomainProblemBindingPolicy(f.source.slug, "1001", f.platform, 1, {
    mode: "any",
  }, "源域采用最新版");
  assertEquals(
    (await resolveDomainProblem(f.school.slug, "public-source:1001", f.student))
      .version.id,
    f.versions[0],
  );
  const updated = await setDomainProblemBindingPolicy(
    f.school.slug,
    "public-source:1001",
    f.teacher,
    0,
    { mode: "any" },
    "学校切换版本",
  );
  assertEquals(updated.revision, 1);
  assertEquals(
    (await resolveDomainProblem(f.school.slug, "public-source:1001", f.student))
      .version.id,
    f.versions[1],
  );
  await assertRejects(
    () =>
      setDomainProblemBindingPolicy(
        f.school.slug,
        "public-source:1001",
        f.teacher,
        0,
        { mode: "any" },
        "过期请求",
      ),
    ConflictError,
  );
  await assertRejects(() =>
    setDomainProblemBindingPolicy(
      f.school.slug,
      "public-source:1001",
      f.teacher,
      1,
      { mode: "exact", version_id: f.versions[2] },
      "错误源题版本",
    )
  );
  await assertRejects(
    () => resolveDomainProblem(f.school.slug, "1001", f.student),
    NotFoundError,
  );
  await assertRejects(
    () => resolveDomainProblem(f.other.slug, "public-source:1001", f.student),
    NotFoundError,
  );
  await assertRejects(
    () => importDomainProblem(f.school.slug, "public-source:1002", f.student),
    ForbiddenError,
  );
  const history = await getDb().select().from(problemBindingHistory).where(
    eq(problemBindingHistory.binding_id, imported.binding.id),
  );
  assertEquals(history.map((h) => h.revision), [0, 1]);
});

Deno.test("共享撤销：管理员也被拒绝，恢复复用绑定；离域、源域私有及停用立即生效", async () => {
  const f = await fixture();
  const imported = await importDomainProblem(
    f.school.slug,
    "public-source:1001",
    f.teacher,
  );
  const sourceBindingWhere = and(
    eq(domainProblemBindings.domain_id, f.source.id),
    eq(domainProblemBindings.problem_id, f.problem),
  );
  await getDb().update(domainProblemBindings).set({
    disabled_at: new Date().toISOString(),
  }).where(sourceBindingWhere);
  await assertRejects(
    () => resolveDomainProblem(f.school.slug, "public-source:1001", f.platform),
    NotFoundError,
  );
  await getDb().update(domainProblemBindings).set({ disabled_at: null }).where(
    sourceBindingWhere,
  );
  await setDomainProblemSharing(f.source.slug, "1001", f.platform, {
    expectedRevision: 1,
    enabled: false,
    scope: "all",
    targetDomainIds: [],
  });
  for (const actor of [f.student, f.teacher, f.platform]) {
    await assertRejects(
      () => resolveDomainProblem(f.school.slug, "public-source:1001", actor),
      NotFoundError,
    );
  }
  await assertRejects(
    () => importDomainProblem(f.other.slug, "public-source:1001", f.platform),
    NotFoundError,
  );
  assertEquals(
    (await getDb().select().from(domainProblemBindings).where(
      eq(domainProblemBindings.id, imported.binding.id),
    )).length,
    1,
  );
  await setDomainProblemSharing(f.source.slug, "1001", f.platform, {
    expectedRevision: 2,
    enabled: true,
    scope: "selected",
    targetDomainIds: [f.school.id],
  });
  assertEquals(
    (await importDomainProblem(f.school.slug, "public-source:1001", f.teacher))
      .binding.id,
    imported.binding.id,
  );
  await assertRejects(
    () => importDomainProblem(f.other.slug, "public-source:1001", f.platform),
    NotFoundError,
  );
  await removeDomainMember(f.school.slug, f.platform, f.student);
  await assertRejects(
    () => resolveDomainProblem(f.school.slug, "public-source:1001", f.student),
    NotFoundError,
  );
  await updateDomain(f.source.slug, f.platform, 0, {
    configuration: { ...f.source.configuration, access: "members" },
  });
  await assertRejects(
    () => resolveDomainProblem(f.school.slug, "public-source:1001", f.platform),
    NotFoundError,
  );
  await updateDomain(f.source.slug, f.platform, 1, {
    configuration: f.source.configuration,
  });
  await setDomainStatus(f.source.slug, f.platform, "suspended", 2);
  await assertRejects(
    () => resolveDomainProblem(f.school.slug, "public-source:1001", f.teacher),
    NotFoundError,
  );
});

Deno.test("引用容量：最后一个条目只接受一次，重复请求不增加计数，错误权限不泄漏政策", async () => {
  const f = await fixture();
  await getDb().update(domainLimits).set({ problems: 1 }).where(
    eq(domainLimits.domain_id, f.school.id),
  );
  const results = await Promise.allSettled(
    [1001, 1002].map((number) =>
      importDomainProblem(f.school.slug, `public-source:${number}`, f.teacher)
    ),
  );
  assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
  const failed = results.find((r) => r.status === "rejected");
  assert(failed?.status === "rejected");
  assertEquals(failed.reason.code, "DOMAIN_PROBLEM_LIMIT");
  const success = results.find((r) => r.status === "fulfilled");
  assert(success?.status === "fulfilled");
  assertEquals(
    (await importDomainProblem(
      f.school.slug,
      success.value.reference.qualified_ref,
      f.teacher,
    )).binding.id,
    success.value.binding.id,
  );
  const [counter] = await getDb().select().from(domainResourceCounters).where(
    and(
      eq(domainResourceCounters.domain_id, f.school.id),
      eq(domainResourceCounters.resource, "problems"),
    ),
  );
  assertEquals(counter.used, 1);
  await assertRejects(
    () =>
      setDomainProblemSharing(f.source.slug, "1001", f.teacher, {
        expectedRevision: 1,
        enabled: false,
        scope: "all",
        targetDomainIds: [],
      }),
    ForbiddenError,
  );
});
