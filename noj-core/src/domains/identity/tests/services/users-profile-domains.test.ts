import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  communityPosts,
  domains,
  problems,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { presetConfiguration } from "../../../workspace/index.ts";
import {
  queryProfileCommunityStats,
  queryProfileMoments,
  queryProfileSolutions,
  queryProfileStats,
  queryRecentSubmissions,
  querySolvedProblems,
} from "../../services/users/users-profile-queries.ts";

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
      id: "profile-private-moment",
      domain_id: "profile-school",
      author_id: actor,
      type: "moment",
      title: null,
      content: "秘密活动",
      status: "published",
      created_at: now,
      updated_at: now,
    },
    {
      id: "profile-private-solution",
      domain_id: "profile-school",
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
    Number((await queryProfileCommunityStats(db, actor))!.moment_count),
    0,
  );
  assertEquals(
    Number((await queryProfileCommunityStats(db, actor))!.solution_count),
    0,
  );
  assertEquals((await queryProfileMoments(db, actor)).length, 0);
  assertEquals((await queryProfileSolutions(db, actor)).length, 0);
  // 主域legacy记录仍可见；改域后无需索引或缓存失效，立即从公开统计撤除。
  await db.insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id: "profile-main-problem",
    number: 997011,
    title: "公开题",
    description: "题面",
    created_at: now,
    updated_at: now,
  });
  await db.insert(submissions).values({
    id: "profile-main-submit",
    problem_id: "profile-main-problem",
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
  await db.update(submissions).set({ domain_id: "profile-school" }).where(
    eq(submissions.id, "profile-main-submit"),
  );
  assertEquals(
    Number((await queryProfileStats(db, actor))!.total_submissions),
    0,
  );
});
