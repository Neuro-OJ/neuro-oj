import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  classroomMemberships,
  classrooms,
  contests,
  domainMemberships,
  domainProblemBindings,
  domains,
  problems,
  problemShareSettings,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { publishAllProblemsForTest } from "../../../../../tests/helper.ts";
import {
  DEFAULT_DOMAIN_ID,
  ensureDefaultWorkspace,
  presetConfiguration,
} from "../../../workspace/index.ts";
import { searchFlat, searchGrouped } from "../../services/search.ts";
import {
  buildProblemEntry,
  buildSubmissionEntry,
  upsertSearchEntry,
} from "../../services/index-writer.ts";
import { domainSearchRouter } from "../../routes/search.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import { signToken } from "../../../identity/index.ts";
export async function fixture() {
  await resetDbForTest();
  const db = getDb(), now = new Date().toISOString(), actor = "query-student";
  await db.insert(users).values({
    id: actor,
    username: actor,
    email: `${actor}@example.com`,
    created_at: now,
    updated_at: now,
  });
  await ensureDefaultWorkspace();
  await db.insert(domains).values(
    ["school-query-a", "school-query-b"].map((id) => ({
      id,
      slug: id,
      name: id,
      owner_id: actor,
      preset: "education" as const,
      configuration: presetConfiguration("education"),
      created_at: now,
      updated_at: now,
    })),
  );
  await db.insert(domainMemberships).values(
    ["school-query-a", "school-query-b"].map((domain_id) => ({
      id: `member-${domain_id}`,
      domain_id,
      user_id: actor,
      status: "active" as const,
      joined_at: now,
    })),
  );
  await db.insert(problems).values({
    id: "query-source",
    domain_id: DEFAULT_DOMAIN_ID,
    number: 997001,
    title: "共享题",
    description: "题面",
    owner_id: actor,
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
  await db.insert(domainProblemBindings).values(
    [DEFAULT_DOMAIN_ID, "school-query-a", "school-query-b"].map(
      (domain_id) => ({
        id: `binding-${domain_id}`,
        domain_id,
        problem_id: "query-source",
        kind: domain_id === DEFAULT_DOMAIN_ID
          ? "owned" as const
          : "shared" as const,
        visibility: "public" as const,
        created_by: actor,
        created_at: now,
        updated_at: now,
      }),
    ),
  );
  await publishAllProblemsForTest();
  await db.insert(problemShareSettings).values({
    problem_id: "query-source",
    enabled: true,
    scope: "all",
    updated_by: actor,
    updated_at: now,
  });
  await db.insert(submissions).values(
    [DEFAULT_DOMAIN_ID, "school-query-a", "school-query-b"].map(
      (domain_id) => ({
        id: `submit-${domain_id}`,
        domain_id,
        domain_problem_binding_id: `binding-${domain_id}`,
        problem_id: "query-source",
        user_id: actor,
        language: "python3",
        code: "print(1)",
        version_origin: "legacy_unknown" as const,
        is_valid: true,
        is_accepted: domain_id !== "school-query-b",
        status: "finished" as const,
        created_at: now,
      }),
    ),
  );
  return { db, actor, now };
}

const search = (
  domainId: string,
  actor: string,
  q = "共享题",
  type = "problem",
) =>
  searchFlat({
    q,
    type,
    page: 1,
    perPage: 1,
    ctx: {
      domainId,
      userId: actor,
      isAdmin: false,
      member: true,
      guestReadEnabled: true,
    },
  });
Deno.test("域搜索：同源题引用在目标域使用、撤销即时影响命中与分页", async () => {
  const { db, actor } = await fixture();
  await upsertSearchEntry((await buildProblemEntry("query-source"))!);
  const shared = await search("school-query-a", actor);
  assertEquals(shared.items.length, 1);
  assertEquals(shared.items[0].metadata.reference, {
    problem_id: "query-source",
    source_domain_id: DEFAULT_DOMAIN_ID,
    source_domain_slug: "main",
    number: 997001,
    qualified_ref: "main:997001",
    display_ref: "main:997001",
    is_shared: true,
  });
  const local = await search(DEFAULT_DOMAIN_ID, actor);
  assertEquals(
    (local.items[0].metadata.reference as Record<string, unknown>).display_ref,
    "997001",
  );
  assertEquals(
    (local.items[0].metadata.reference as Record<string, unknown>).is_shared,
    false,
  );
  assertEquals((await search("unknown-domain", actor)).items.length, 0);
  await db.update(domainProblemBindings).set({
    disabled_at: new Date().toISOString(),
  })
    .where(eq(domainProblemBindings.id, "binding-school-query-a"));
  assertEquals((await search("school-query-a", actor)).items.length, 0);
  assertEquals((await search("school-query-b", actor)).items.length, 1);
  await db.update(problemShareSettings).set({ enabled: false }).where(
    eq(problemShareSettings.problem_id, "query-source"),
  );
  assertEquals((await search("school-query-b", actor)).items.length, 0);
  assertEquals(
    (await searchGrouped({
      q: "共享题",
      types: ["problem"],
      perType: 1,
      ctx: {
        domainId: "school-query-b",
        userId: actor,
        isAdmin: false,
        member: true,
        guestReadEnabled: true,
      },
    })).groups.problem.has_more,
    false,
  );
  assertEquals((await search(DEFAULT_DOMAIN_ID, actor)).items.length, 1);
});
Deno.test("域搜索：索引未删除的私有提交受比赛窗口约束，其他域不匹配", async () => {
  const { db, actor, now } = await fixture();
  const submissionId = "submit-school-query-a";
  await upsertSearchEntry((await buildSubmissionEntry(submissionId))!);
  assertEquals(
    (await search("school-query-a", actor, "共享题", "submission")).items
      .length,
    1,
  );
  assertEquals(
    (await search("school-query-b", actor, "共享题", "submission")).items
      .length,
    0,
  );
  await db.insert(contests).values({
    id: "search-oi",
    domain_id: "school-query-a",
    title: "OI",
    type: "oi",
    kind: "public",
    is_public: true,
    created_by: actor,
    start_time: now,
    end_time: new Date(Date.now() + 3600000).toISOString(),
    created_at: now,
    updated_at: now,
  });
  await db.update(submissions).set({ contest_id: "search-oi" }).where(
    eq(submissions.id, submissionId),
  );
  assertEquals(
    (await search("school-query-a", actor, "finished", "submission")).items
      .length,
    0,
  );
  assertEquals(
    (await search("school-query-a", actor, "共享题", "submission")).items
      .length,
    0,
  );
  await db.update(contests).set({
    start_time: new Date(Date.now() - 10000).toISOString(),
    end_time: new Date(Date.now() - 1000).toISOString(),
  }).where(eq(contests.id, "search-oi"));
  assertEquals(
    (await search("school-query-a", actor, "共享题", "submission")).items
      .length,
    1,
  );
});
Deno.test("域搜索HTTP：私有学校匿名路径拒绝", async () => {
  const { actor } = await fixture();
  await upsertSearchEntry((await buildProblemEntry("query-source"))!);
  const app = new Hono();
  app.onError((e, c) =>
    c.json(
      { error: e.message },
      e instanceof AppError ? e.statusCode as 404 : 500,
    )
  );
  app.route("/", domainSearchRouter);
  assertEquals(
    (await app.request("/domains/school-query-a/search?q=共享题")).status,
    404,
  );
  const token = await signToken({ sub: actor, role: "user" });
  const response = await app.request(
    "/domains/school-query-a/search?q=共享题&type=problem",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assertEquals(response.status, 200);
  assertEquals((await response.json()).data.items.length, 1);
});
Deno.test("域搜索教学权限：当前教练可搜学生同域提交，离职和离班立即撤权", async () => {
  const { db, actor, now } = await fixture(),
    coach = "search-current-coach",
    domain = "school-query-a";
  await db.insert(users).values({
    id: coach,
    username: coach,
    email: `${coach}@example.com`,
    created_at: now,
    updated_at: now,
  });
  await db.insert(domainMemberships).values({
    id: "coach-domain",
    domain_id: domain,
    user_id: coach,
    joined_at: now,
  });
  await db.insert(classrooms).values({
    id: "search-class",
    domain_id: domain,
    name: "班级",
    primary_coach_id: coach,
    created_at: now,
    updated_at: now,
  });
  await db.insert(classroomMemberships).values([
    {
      id: "search-coach",
      domain_id: domain,
      classroom_id: "search-class",
      user_id: coach,
      role: "coach",
      joined_at: now,
      appointed_at: now,
    },
    {
      id: "search-student",
      domain_id: domain,
      classroom_id: "search-class",
      user_id: actor,
      role: "student",
      joined_at: now,
      appointed_at: now,
    },
  ]);
  await upsertSearchEntry(
    (await buildSubmissionEntry("submit-school-query-a"))!,
  );
  assertEquals(
    (await search(domain, coach, "共享题", "submission")).items.length,
    1,
  );
  assertEquals(
    (await search("school-query-b", coach, "共享题", "submission")).items
      .length,
    0,
  );
  await db.update(classroomMemberships).set({ status: "removed" }).where(
    eq(classroomMemberships.id, "search-coach"),
  );
  assertEquals(
    (await search(domain, coach, "共享题", "submission")).items.length,
    0,
  );
  await db.update(classroomMemberships).set({ status: "active" }).where(
    eq(classroomMemberships.id, "search-coach"),
  );
  await db.update(classroomMemberships).set({ status: "removed" }).where(
    eq(classroomMemberships.id, "search-student"),
  );
  assertEquals(
    (await search(domain, coach, "共享题", "submission")).items.length,
    0,
  );
});
Deno.test("域搜索比赛摘要：旧索引赛题关键词及metadata不成为保密旁路", async () => {
  const { db, actor, now } = await fixture();
  await db.insert(contests).values({
    id: "search-summary",
    domain_id: "school-query-a",
    title: "公开摘要",
    description: "活动说明",
    type: "oi",
    kind: "public",
    is_public: true,
    created_by: actor,
    start_time: now,
    end_time: new Date(Date.now() + 3600000).toISOString(),
    created_at: now,
    updated_at: now,
  });
  await upsertSearchEntry({
    entityType: "contest",
    entityId: "search-summary",
    title: "公开摘要",
    body: "保密关键词",
    metadata: {
      kind: "public",
      problem_titles: ["保密关键词"],
      problem_display_ids: ["main:1001"],
    },
    isPublic: true,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
  assertEquals(
    (await search("school-query-a", actor, "保密关键词", "contest")).items
      .length,
    0,
  );
  const result = await search("school-query-a", actor, "公开摘要", "contest");
  assertEquals(result.items.length, 1);
  assertEquals(result.items[0].metadata.problem_titles, undefined);
  assertEquals(result.items[0].metadata.problem_display_ids, undefined);
});
