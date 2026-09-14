import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { contests, problems, users } from "../../../../shared/db/schema.ts";
import {
  countPostsByType,
  createPost,
  getPost,
  listBookmarks,
  listFeed,
  listPosts,
  toggleBookmark,
} from "../../index.ts";
import { createContest } from "../../../contest/index.ts";
import {
  _resetSystemSettingsForTest,
  ensureRbacSeeds,
  enterTestContext,
  initSystemSettings,
  leaveTestContext,
  updateSetting,
} from "../../../system/index.ts";

const ownerId = "gating-owner";
const normalProblemId = "gating-normal-problem";
const contestProblemId = "gating-contest-problem";
let contestId = "";

async function setup(): Promise<void> {
  await resetDbForTest();
  await ensureRbacSeeds();
  _resetSystemSettingsForTest();
  await initSystemSettings();
  const now = new Date().toISOString();
  await getDb().insert(users).values({
    id: ownerId,
    username: ownerId,
    email: `${ownerId}@example.com`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  await getDb().insert(problems).values([
    {
      id: normalProblemId,
      title: "普通练习题",
      description: "x",
      difficulty: "easy",
      runtime_config: {},
      number: 970001,
      type: "U",
      visibility: "public",
      owner_id: ownerId,
      created_at: now,
      updated_at: now,
    },
    {
      id: contestProblemId,
      title: "竞赛题目",
      description: "x",
      difficulty: "easy",
      runtime_config: {},
      number: 970002,
      type: "U",
      visibility: "public",
      owner_id: ownerId,
      created_at: now,
      updated_at: now,
    },
  ]);
  enterTestContext({ actorId: "0", actorIp: "127.0.0.1", actorRole: "admin" });
  try {
    await updateSetting("community_enabled", true, "0");
    await updateSetting("community_new_user_review_hours", 0, "0");
  } finally {
    leaveTestContext();
  }
  // 一场进行中的竞赛，含 contestProblemId
  const contest = await createContest(
    {
      title: `门控测试 ${Date.now()}`,
      start_time: new Date(Date.now() - 60_000).toISOString(),
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      type: "kaggle",
      problems: [{
        problem_id: contestProblemId,
        label: "A",
        sort_order: 0,
        score: 10000,
      }],
    },
    ownerId,
    true,
  );
  contestId = contest.id;
}

/** 以审核员身份发布题解（绕过发布门槛，专注验证读路径门控）。 */
async function seedSolution(problemId: string, title: string) {
  return await createPost(ownerId, {
    type: "solution",
    title,
    content: `内容 ${title}`,
    problem_id: problemId,
  }, true);
}

Deno.test({
  name: "solution-gating: 赛期竞赛题题解在列表不可见，普通题题解正常",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    await seedSolution(normalProblemId, "普通题题解");
    await seedSolution(contestProblemId, "竞赛题题解");

    // 普通用户视角（moderator 缺省 false）
    const contestList = await listPosts({
      type: "solution",
      problemId: contestProblemId,
    });
    assertEquals(contestList.data.length, 0);

    const normalList = await listPosts({
      type: "solution",
      problemId: normalProblemId,
    });
    assertEquals(normalList.data.length, 1);

    // 审核员不受限（复核需要）
    const moderatorView = await listPosts({
      type: "solution",
      problemId: contestProblemId,
      moderator: true,
    });
    assertEquals(moderatorView.data.length, 1);
  },
});

Deno.test({
  name: "solution-gating: 赛期题解详情不可见（含发布者本人）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const post = await seedSolution(contestProblemId, "竞赛题题解");

    // 发布者本人亦不可见：避免通过自视图形成侧信道确认
    await assertRejects(
      () => getPost(post.id, ownerId, false),
      Error,
    );
    // 审核员可见
    const moderatorRead = await getPost(post.id, ownerId, true);
    assertEquals(moderatorRead.post.id, post.id);
  },
});

Deno.test({
  name: "solution-gating: 竞赛结束后题解自动恢复可见（无调度依赖）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const post = await seedSolution(contestProblemId, "竞赛题题解");

    assertEquals(
      (await listPosts({ type: "solution", problemId: contestProblemId }))
        .data.length,
      0,
    );

    // 把结束时间改到过去 → 判定应实时翻转
    await getDb().update(contests)
      .set({ end_time: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(contests.id, contestId));

    const after = await listPosts({
      type: "solution",
      problemId: contestProblemId,
    });
    assertEquals(after.data.length, 1);
    const detail = await getPost(post.id, ownerId, false);
    assertEquals(detail.post.id, post.id);
  },
});

Deno.test({
  name: "solution-gating: 未开始（pending）竞赛不触发门控",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    await seedSolution(contestProblemId, "竞赛题题解");
    // 改为未开始
    await getDb().update(contests)
      .set({
        start_time: new Date(Date.now() + 3_600_000).toISOString(),
        end_time: new Date(Date.now() + 7_200_000).toISOString(),
      })
      .where(eq(contests.id, contestId));

    const list = await listPosts({
      type: "solution",
      problemId: contestProblemId,
    });
    assertEquals(list.data.length, 1);
  },
});

Deno.test({
  name: "solution-gating: 门控不计入题解 Tab 计数",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    await seedSolution(normalProblemId, "普通题题解");
    await seedSolution(contestProblemId, "竞赛题题解");

    const counts = await countPostsByType();
    // 只有普通题的那条被计入
    assertEquals(counts.solution, 1);
  },
});

Deno.test({
  name: "solution-gating: 门控不影响讨论与动态",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    // discussion/moment 不受门控影响
    const moment = await createPost(ownerId, {
      type: "moment",
      content: "一条动态",
    }, true);
    assertEquals(moment.type, "moment");
    const counts = await countPostsByType();
    assertEquals(counts.moment, 1);
  },
});

Deno.test({
  name: "solution-gating: 门控覆盖全部五条读路径（列表/详情/计数/收藏/动态）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const post = await seedSolution(contestProblemId, "竞赛题题解");

    // 1. 列表
    assertEquals(
      (await listPosts({ type: "solution", problemId: contestProblemId }))
        .data.length,
      0,
    );
    // 2. 详情
    await assertRejects(() => getPost(post.id, ownerId, false), Error);
    // 3. 计数（赛期不计入）
    assertEquals((await countPostsByType()).solution, 0);
    // 4. 收藏（收藏后仍不可见）
    await toggleBookmark(ownerId, post.id);
    const bookmarks = await listBookmarks(ownerId);
    assertEquals(
      bookmarks.data.filter((row) => row.post.id === post.id).length,
      0,
    );
    // 5. 动态流（solution_published 活动不出现）
    const feed = await listFeed("latest", ownerId);
    assertEquals(
      feed.data.filter((item) =>
        item.kind === "activity" &&
        item.activity?.type === "solution_published"
      ).length,
      0,
    );

    // 赛后全部恢复
    await getDb().update(contests)
      .set({ end_time: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(contests.id, contestId));
    assertEquals(
      (await listPosts({ type: "solution", problemId: contestProblemId }))
        .data.length,
      1,
    );
    assertEquals((await countPostsByType()).solution, 1);
  },
});
