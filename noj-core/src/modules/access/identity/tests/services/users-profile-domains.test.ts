import {
  bindPublishedProblemForTest,
  problemExecutionForTest,
  publishBaselineVersionForTest,
} from "../../../../../../tests/helper.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../../shared/workspace/types.ts";
import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import {
  communityPosts,
  domains,
  problems,
  submissions,
  users,
} from "../../../../../shared/db/schema.ts";
import { presetConfiguration } from "../../../workspace/index.ts";
import {
  queryProfileCommunityStats,
  queryProfileCreatedProblems,
  queryProfileSolutions,
  queryProfileStats,
  queryRecentSubmissions,
  querySolvedProblems,
} from "../../../../read-models/queries/services/user-profile-queries.ts";

Deno.test("公共主页：本人和平台管理员也不能聚合私有域提交、通过、社区动态", async () => {
  await resetDbForTest();
  const db = getDb(),
    now = new Date().toISOString(),
    actor = "profile-domain-student";
  await db.insert(users).values({
    id: actor,
    username: actor,
    email: `${actor}@example.com`,
    created_at: now,
    updated_at: now,
  });
  await db.insert(domains).values({
    id: "profile-school",
    slug: "profile-school",
    name: "私有学校",
    owner_id: actor,
    preset: "education",
    configuration: presetConfiguration("education"),
    created_at: now,
    updated_at: now,
  });
  await db.insert(problems).values({
    id: "profile-school-problem",
    domain_id: "profile-school",
    number: 997010,
    title: "私有题",
    description: "私有题面",
    created_at: now,
    updated_at: now,
  });
  await db.insert(submissions).values({
    id: "profile-private-submit",
    domain_id: "profile-school",
    problem_id: "profile-school-problem",
    domain_problem_binding_id: await bindPublishedProblemForTest(
      "profile-school-problem",
    ),
    user_id: actor,
    language: "python3",
    code: "secret",
    version_origin: "legacy_unknown",
    is_valid: true,
    is_accepted: true,
    status: "finished",
    created_at: now,
  });
  await db.insert(communityPosts).values([
    {
      id: "profile-private-solution",
      domain_id: "profile-school",
      domain_problem_binding_id: await bindPublishedProblemForTest(
        "profile-school-problem",
      ),
      problem_id: "profile-school-problem",
      author_id: actor,
      type: "solution",
      title: "秘密题解",
      content: "题解内容",
      status: "published",
      created_at: now,
      updated_at: now,
    },
  ]);
  for (
    const viewer of [{}, { viewerId: actor }, {
      viewerId: actor,
      isAdmin: true,
    }]
  ) {
    const stats = await queryProfileStats(db, actor, viewer);
    assertExists(stats);
    assertEquals(Number(stats.total_submissions), 0);
    assertEquals(Number(stats.solved_count), 0);
    assertEquals((await querySolvedProblems(db, actor, viewer)).length, 0);
    assertEquals((await queryRecentSubmissions(db, actor, viewer)).length, 0);
  }
  assertEquals(
    Number((await queryProfileCommunityStats(db, actor))!.solution_count),
    0,
  );
  assertEquals((await queryProfileSolutions(db, actor)).length, 0);
  // 主域已发布题的历史记录可见；域收紧访问政策后公开统计立即撤除。
  await db.insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id: "profile-main-problem",
    number: 997011,
    title: "公开题",
    description: "题面",
    created_at: now,
    updated_at: now,
  });
  await publishBaselineVersionForTest("profile-main-problem");
  await db.insert(submissions).values({
    id: "profile-main-submit",
    problem_id: "profile-main-problem",
    ...await problemExecutionForTest("profile-main-problem"),
    user_id: actor,
    language: "python3",
    code: "public",
    version_origin: "legacy_unknown",
    is_valid: true,
    is_accepted: true,
    status: "finished",
    created_at: now,
  });
  assertEquals(
    Number((await queryProfileStats(db, actor))!.total_submissions),
    1,
  );
  await db.update(domains).set({
    configuration: { ...presetConfiguration("community"), access: "members" },
  }).where(
    eq(domains.id, DEFAULT_DOMAIN_ID),
  );
  assertEquals(
    Number((await queryProfileStats(db, actor))!.total_submissions),
    0,
  );
});

Deno.test("公共主页「创建的题目」：按域可见性逐行过滤（审计 F5）", async () => {
  await resetDbForTest();
  const db = getDb(), now = new Date().toISOString(), owner = "profile-author";
  await db.insert(users).values({
    id: owner,
    username: owner,
    email: `${owner}@example.com`,
    created_at: now,
    updated_at: now,
  });
  // 私有域（members）里的题：匿名查看者看不到，owner 本人与管理员可见
  await db.insert(domains).values({
    id: "profile-private-domain",
    slug: "profile-private-domain",
    name: "私有学校",
    owner_id: owner,
    preset: "education",
    configuration: presetConfiguration("education"),
    created_at: now,
    updated_at: now,
  });
  await db.insert(problems).values({
    id: "profile-authored-problem",
    domain_id: "profile-private-domain",
    number: 997020,
    title: "我出的题",
    description: "题面",
    owner_id: owner,
    created_at: now,
    updated_at: now,
  });
  await bindPublishedProblemForTest("profile-authored-problem");
  await publishBaselineVersionForTest("profile-authored-problem");

  // 匿名查看者：私有域不返回
  assertEquals(
    (await queryProfileCreatedProblems(db, owner, {})).length,
    0,
    "匿名查看者不得看到私有域里创建的题目",
  );
  // 主页本人：可见，且 display_id 带域 slug 前缀（前端据此生成域路由）
  const own = await queryProfileCreatedProblems(db, owner, {
    viewerId: owner,
  });
  assertEquals(own.length, 1);
  assertEquals(own[0]!.display_id, "profile-private-domain:997020");
  // 平台管理员：可见
  assertEquals(
    (await queryProfileCreatedProblems(db, owner, {
      viewerId: "admin-viewer",
      isAdmin: true,
    })).length,
    1,
  );
});
