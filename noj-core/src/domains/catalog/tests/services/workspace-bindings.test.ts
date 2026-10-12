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
  domainLimits,
  domainProblemBindings,
  domainResourceCounters,
  domains,
  problemBindingHistory,
  problems,
  problemVersions,
  roles,
  trainings,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
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
      type: "P",
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
      content: { kind: "ai", title: `V${i}`, description: "不可变内容" },
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

Deno.test("默认域回填：保留源 ID、版本、题号和策略，重复运行不覆盖独立绑定", async () => {
  await resetDbForTest();
  await ensureDefaultWorkspace();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const version = crypto.randomUUID();
  await getDb().insert(problems).values({
    id,
    number: 4321,
    type: "P",
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
    id: crypto.randomUUID(),
    title: "旧题单",
    created_by: "0",
    created_at: now,
    updated_at: now,
  });
  assertEquals(await backfillDefaultCatalog(), {
    problems_assigned: 1,
    trainings_assigned: 1,
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

Deno.test("默认域回填：未处理 U 题阻止整个事务，不默默转换或清除", async () => {
  await resetDbForTest();
  await ensureDefaultWorkspace();
  const now = new Date().toISOString();
  await getDb().insert(problems).values(
    ["P", "U"].map((type, i) => ({
      id: crypto.randomUUID(),
      type,
      number: 1001 + i,
      title: "旧题",
      description: "题面",
      created_at: now,
      updated_at: now,
    })),
  );
  const error = await assertRejects(() => backfillDefaultCatalog(), AppError);
  assertEquals(error.code, "LEGACY_U_DATA_REQUIRES_REVIEW");
  assertEquals(
    (await getDb().select().from(problems)).every((p) => p.domain_id === null),
    true,
  );
  assertEquals((await getDb().select().from(domainProblemBindings)).length, 0);
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
