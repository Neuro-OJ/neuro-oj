import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { contests, problems, users } from "../../../../shared/db/schema.ts";
import {
  communityBookmarks,
  communityComments,
  communityPostLikes,
} from "../../../../shared/db/schema.ts";
import {
  countPostsByType,
  createPost,
  createReport,
  getPost,
  getReportDetail,
  listBookmarks,
  listFeed,
  listPosts,
  toggleBookmark,
  togglePostLike,
} from "../../index.ts";
import { createContest } from "../../../contest/index.ts";
import { getUserProfileAggregate } from "../../../identity/index.ts";
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
    // 4. 互动（High#6）：对门控帖的点赞/收藏必须被拒绝，既防写入隐藏互动行，
    //    也避免"成功 vs 外键错"构成存在性预言机
    await assertRejects(() => toggleBookmark(ownerId, post.id), Error);
    await assertRejects(() => togglePostLike(ownerId, post.id), Error);
    // 门控生效期间不应产生任何互动行
    const likeRows = await getDb().select().from(communityPostLikes)
      .where(eq(communityPostLikes.post_id, post.id));
    assertEquals(likeRows.length, 0);
    const bookmarkRows = await getDb().select().from(communityBookmarks)
      .where(eq(communityBookmarks.post_id, post.id));
    assertEquals(bookmarkRows.length, 0);
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

    // 赛后全部恢复（含互动不再被拒）
    await getDb().update(contests)
      .set({ end_time: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(contests.id, contestId));
    assertEquals(
      (await listPosts({ type: "solution", problemId: contestProblemId }))
        .data.length,
      1,
    );
    assertEquals((await countPostsByType()).solution, 1);
    assertEquals(await toggleBookmark(ownerId, post.id), true);
    assertEquals(
      (await listBookmarks(ownerId))
        .data.filter((row) => row.post.id === post.id).length,
      1,
    );
  },
});

/**
 * High#1/#2 回归（2026-09-14 评审）：用户主页是**匿名可访问**的公开路径
 * （无 auth 中间件，文档标注"公开访问，无需认证"），但它的题解列表与题解计数
 * 此前完全未门控 → 泄露赛期题解的**标题与内部 id**，以及"该题有题解"这一事实。
 *
 * 门控必须与社区列表口径一致，否则该路径即为旁路。
 */
Deno.test({
  name: "solution-gating(High#1/#2): 匿名用户主页不泄露赛期题解标题与数量",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    await seedSolution(normalProblemId, "普通题题解");
    await seedSolution(contestProblemId, "竞赛题题解");

    // 普通访问者（非审核员）：赛期题解不应出现在主页题解列表，也不计入数量
    const asVisitor = await getUserProfileAggregate(ownerId, false);
    assertEquals(
      asVisitor.solutions.some((s) => s.title.includes("竞赛题题解")),
      false,
    );
    assertEquals(
      asVisitor.solutions.some((s) => s.title.includes("普通题题解")),
      true,
    );
    assertEquals(asVisitor.community_stats.solution_count, 1);

    // 审核员视图：免门控（复核需要）
    const asModerator = await getUserProfileAggregate(ownerId, true);
    assertEquals(
      asModerator.solutions.some((s) => s.title.includes("竞赛题题解")),
      true,
    );
    assertEquals(asModerator.community_stats.solution_count, 2);

    // 赛后：普通访问者恢复可见（列表与计数必须同时恢复，避免"数量 2、列表 1"的侧信道）
    await getDb().update(contests)
      .set({
        start_time: new Date(Date.now() - 7_200_000).toISOString(),
        end_time: new Date(Date.now() - 1_000).toISOString(),
      })
      .where(eq(contests.id, contestId));
    const afterEnd = await getUserProfileAggregate(ownerId, false);
    assertEquals(
      afterEnd.solutions.some((s) => s.title.includes("竞赛题题解")),
      true,
    );
    assertEquals(afterEnd.community_stats.solution_count, 2);
  },
});

/**
 * 评审 #1 回归：评论工单的门控只看 `report.post_id`，而评论工单的 post_id 为 null。
 *
 * `getReportDetail` 同时查 post/comment，但门控只判断 `row.post?.problem_id`、
 * 只清理 `post.content`。评论工单的 `row.post` 恒为 null，于是
 * `comment.content` 与 `content_snapshot` 会**原样**返回给举报人——
 * 赛期题解的评论全文由此泄露。
 *
 * 修复：沿 comment -> parent post 取门控依据，并同时清理评论正文与快照。
 */
Deno.test({
  name: "solution-gating(评审#1): 赛期题解的评论工单详情不泄露评论正文与快照",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    // 赛期题解 + 其下评论；评论直接写库（createComment 会走 getPost 门控）
    const post = await seedSolution(contestProblemId, "竞赛题题解");
    const commentId = crypto.randomUUID();
    const secret = "赛期题解评论的机密正文";
    const now = new Date().toISOString();
    await getDb().insert(communityComments).values({
      id: commentId,
      post_id: post.id,
      author_id: ownerId,
      parent_id: null,
      content: secret,
      status: "published",
      moderation_reason: null,
      created_at: now,
      updated_at: now,
    });
    // 以审核员身份建单（普通举报在赛期会被 404，拿不到"存量工单"）
    const report = await createReport(ownerId, {
      comment_id: commentId,
      reason: "赛期评论举报",
      category: "其他",
    }, true);
    assertEquals(report.content_snapshot, secret);

    // 举报人（非审核员）查看：快照与评论正文都必须被剥离
    const asReporter = await getReportDetail(report.id, ownerId, false);
    assertEquals(asReporter.report.content_snapshot, "");
    assertEquals(asReporter.comment?.content, "");
    // 父帖投影只含门控元数据，绝不能夹带父帖正文（否则换个字段继续泄露）
    assertEquals("content" in (asReporter.parent_post ?? {}), false);
    // 门控元数据仍应在（调用方据此展示"内容暂不可见"）
    assertEquals(asReporter.parent_post?.problem_id, contestProblemId);

    // 审核员处理工单必须看到全文
    const asModerator = await getReportDetail(report.id, ownerId, true);
    assertEquals(asModerator.report.content_snapshot, secret);
    assertEquals(asModerator.comment?.content, secret);

    // 赛后自动恢复可见（门控实时判定，无调度依赖）
    await getDb().update(contests)
      .set({ end_time: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(contests.id, contestId));
    const afterEnd = await getReportDetail(report.id, ownerId, false);
    assertEquals(afterEnd.report.content_snapshot, secret);
    assertEquals(afterEnd.comment?.content, secret);
  },
});

/**
 * 评审 #1 对照：非赛期题解的评论工单不受影响（避免"一刀切清空"）。
 */
Deno.test({
  name: "solution-gating(评审#1): 普通题评论工单始终返回完整正文",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const post = await seedSolution(normalProblemId, "普通题题解");
    const commentId = crypto.randomUUID();
    const body = "普通题的评论正文";
    const now = new Date().toISOString();
    await getDb().insert(communityComments).values({
      id: commentId,
      post_id: post.id,
      author_id: ownerId,
      parent_id: null,
      content: body,
      status: "published",
      moderation_reason: null,
      created_at: now,
      updated_at: now,
    });
    const report = await createReport(ownerId, {
      comment_id: commentId,
      reason: "普通评论举报",
      category: "其他",
    }, true);
    const detail = await getReportDetail(report.id, ownerId, false);
    assertEquals(detail.report.content_snapshot, body);
    assertEquals(detail.comment?.content, body);
  },
});
