import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import {
  auditLogs,
  communityActivityEvents,
  communityPosts,
  communityReports,
  communitySanctions,
  problems,
  userRoles,
  users,
} from "../../src/db/schema.ts";
import {
  enterTestContext,
  leaveTestContext,
} from "../../src/lib/requestContext.ts";
import {
  applyCommunityPreset,
  assertCommunityWritable,
  changeCommentStatus,
  changePostStatus,
  createActivity,
  createBoard,
  createComment,
  createPost,
  createReport,
  createSanction,
  deleteComment,
  getPost,
  listBookmarks,
  listComments,
  listFeed,
  listNotifications,
  listPendingComments,
  resolveReport,
  toggleBookmark,
  toggleCommentLike,
  togglePostLike,
  updateActivityVisibility,
  updateBoardRoleGrant,
  updatePost,
} from "../../src/domains/community/index.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../src/lib/errors.ts";
import {
  _resetSystemSettingsForTest,
  initSystemSettings,
  updateSetting,
} from "../../src/domains/system/index.ts";
import { ensureRbacSeeds } from "../../src/domains/system/index.ts";

const actorId = "community-test-user";
const observerId = "community-test-observer";

async function setup(): Promise<void> {
  await resetDbForTest();
  // resetDbForTest 会 TRUNCATE roles/community_boards，重新 seed 以保证 FK 与默认板块
  await ensureRbacSeeds();
  _resetSystemSettingsForTest();
  await initSystemSettings();
  const now = new Date().toISOString();
  await getDb().insert(users).values([
    {
      id: actorId,
      username: "community-test-user",
      email: "community-test@example.com",
      password_hash: "hash",
      community_activity_visibility: "everyone",
      created_at: now,
      updated_at: now,
    },
    {
      id: observerId,
      username: "community-test-observer",
      email: "community-test-observer@example.com",
      password_hash: "hash",
      community_activity_visibility: "everyone",
      created_at: now,
      updated_at: now,
    },
  ]);
  await getDb().insert(problems).values({
    id: "community-test-problem",
    title: "社区测试题目",
    description: "测试用题目",
    difficulty: "easy",
    runtime_config: {},
    number: 5001,
    type: "P",
    created_at: now,
    updated_at: now,
  });
  enterTestContext({ actorId: "0", actorIp: "127.0.0.1", actorRole: "admin" });
  try {
    await updateSetting("community_enabled", true, "0");
    await updateSetting("community_moments_enabled", true, "0");
    await updateSetting("community_activities_enabled", true, "0");
    await updateSetting("community_new_user_review_hours", 0, "0");
  } finally {
    leaveTestContext();
  }
}

Deno.test({
  name: "community service: 活动去重并显示在最新动态流",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    await createActivity(actorId, "first_accepted", "problem", "p-1", {});
    await createActivity(actorId, "first_accepted", "problem", "p-1", {});

    const rows = await getDb().select().from(communityActivityEvents).where(
      eq(communityActivityEvents.actor_id, actorId),
    );
    assertEquals(rows.length, 1);

    const feed = await listFeed("latest");
    assertEquals(feed.data.length, 1);
    assertEquals(feed.data[0]?.kind, "activity");
  },
});

Deno.test({
  name: "community service: 讨论互动仅允许一级回复",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const board = await createBoard({ slug: "test-board", name: "测试板块" });
    const post = await createPost(actorId, {
      type: "discussion",
      board_id: board.id,
      title: "测试讨论",
      content: "讨论内容",
    });
    const rootComment = await createComment(actorId, post.id, "一级评论");
    const reply = await createComment(
      actorId,
      post.id,
      "一级回复",
      rootComment.id,
    );
    await assertRejects(
      () => createComment(actorId, post.id, "二级回复", reply.id),
      ValidationError,
      "仅支持回复一级评论",
    );
    assertEquals(await togglePostLike(actorId, post.id), true);
    assertEquals(await toggleBookmark(actorId, post.id), true);
    assertEquals((await getPost(post.id, actorId)).bookmarked, true);
    assertEquals((await getPost(post.id, observerId)).bookmarked, false);
  },
});

Deno.test({
  name: "community service: 收藏列表仅返回自己的已发布内容",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const board = await createBoard({
      slug: "bookmark-board",
      name: "收藏板块",
    });
    const visible = await createPost(actorId, {
      type: "discussion",
      board_id: board.id,
      title: "可见收藏",
      content: "会展示在收藏列表中",
    });
    const hidden = await createPost(actorId, {
      type: "discussion",
      board_id: board.id,
      title: "隐藏收藏",
      content: "不应展示",
    });
    const deleted = await createPost(actorId, {
      type: "discussion",
      board_id: board.id,
      title: "删除收藏",
      content: "不应展示",
    });
    await toggleBookmark(actorId, visible.id);
    await toggleBookmark(actorId, hidden.id);
    await toggleBookmark(actorId, deleted.id);
    await toggleBookmark(observerId, visible.id);
    await getDb().update(communityPosts).set({ status: "hidden" }).where(
      eq(communityPosts.id, hidden.id),
    );
    await getDb().update(communityPosts).set({ status: "deleted" }).where(
      eq(communityPosts.id, deleted.id),
    );

    const result = await listBookmarks(actorId);
    assertEquals(result.data.map((item) => item.post.id), [visible.id]);
    assertEquals(result.data[0]?.author.id, actorId);
  },
});

Deno.test({
  name: "community service: 板块角色授权限制发帖",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const board = await createBoard({
      slug: "restricted-board",
      name: "受限板块",
    });
    await updateBoardRoleGrant(board.id, "user", { can_post: false });
    await assertRejects(
      () =>
        createPost(actorId, {
          type: "discussion",
          board_id: board.id,
          title: "无权讨论",
          content: "不应创建",
        }),
      ForbiddenError,
      "你没有在该板块发帖的权限",
    );
    await getDb().insert(userRoles).values({
      user_id: actorId,
      role_id: "user",
    });
    await updateBoardRoleGrant(board.id, "user", { can_post: true });
    const post = await createPost(actorId, {
      type: "discussion",
      board_id: board.id,
      title: "授权讨论",
      content: "可以创建",
    });
    assertEquals(post.status, "published");
  },
});

Deno.test({
  name: "community service: 社区处罚写入审计且不影响独立记录",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    enterTestContext({
      actorId: "0",
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    try {
      const sanction = await createSanction("0", actorId, "测试处罚");
      const rows = await getDb().select().from(communitySanctions).where(
        eq(communitySanctions.id, sanction.id),
      );
      assertEquals(rows[0]?.user_id, actorId);
      const auditRows = await getDb().select().from(auditLogs).where(
        eq(auditLogs.target_id, actorId),
      );
      assertEquals(auditRows[0]?.action, "community.sanction_created");
    } finally {
      leaveTestContext();
    }
  },
});

Deno.test({
  name: "community service: 预设切换即时收紧社区能力",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    enterTestContext({
      actorId: "0",
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    try {
      const publicConfig = await applyCommunityPreset("0", "public");
      assertEquals(publicConfig.guest_read_enabled, true);
      assertEquals(publicConfig.external_images_enabled, true);

      const knowledgeConfig = await applyCommunityPreset("0", "knowledge");
      assertEquals(knowledgeConfig.read_only, true);
      assertEquals(knowledgeConfig.moments_enabled, false);
      assertEquals(knowledgeConfig.comments_enabled, false);
      assertEquals(knowledgeConfig.follows_enabled, false);
    } finally {
      leaveTestContext();
    }
  },
});

Deno.test({
  name: "community service: 题目不存在拒绝题解，未通过题目仍受门槛限制",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    // 不存在的题目引用 → ValidationError（而非 FK 500）
    await assertRejects(
      () =>
        createPost(actorId, {
          type: "solution",
          problem_id: "problem-not-exist",
          title: "不存在题解",
          content: "不应允许发布",
        }),
      ValidationError,
      "题目不存在",
    );
    // 真实题目（display_id P5001）但作者未通过 → ForbiddenError
    await assertRejects(
      () =>
        createPost(actorId, {
          type: "solution",
          problem_id: "P5001",
          title: "未通过题解",
          content: "不应允许发布",
        }),
      ForbiddenError,
      "通过对应题目后才能发布题解",
    );
  },
});

Deno.test({
  name: "community service: 编辑内容同样受长度限制约束",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const board = await createBoard({ slug: "length-board", name: "长度板块" });
    const post = await createPost(actorId, {
      type: "discussion",
      board_id: board.id,
      title: "长度测试",
      content: "正常内容",
    });
    await assertRejects(
      () =>
        updatePost(post.id, actorId, false, {
          content: "超".repeat(20001),
        }),
      ValidationError,
      "内容超过长度限制",
    );
  },
});

Deno.test({
  name: "community service: 仅允许回复已发布评论，待审评论可被审核批准",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const board = await createBoard({ slug: "reply-board", name: "回复板块" });
    const post = await createPost(actorId, {
      type: "discussion",
      board_id: board.id,
      title: "回复测试",
      content: "内容",
    });
    const rootComment = await createComment(actorId, post.id, "根评论");
    // 待审评论不可回复
    enterTestContext({
      actorId: "0",
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    try {
      await updateSetting("community_new_user_review_hours", 24, "0");
    } finally {
      leaveTestContext();
    }
    const pendingComment = await createComment(observerId, post.id, "待审评论");
    assertEquals(pendingComment.status, "pending");
    await assertRejects(
      () => createComment(actorId, post.id, "回复待审评论", pendingComment.id),
      ValidationError,
      "不能回复未发布或已删除的评论",
    );
    // 审核批准后作者收到回复通知，且可回复
    enterTestContext({
      actorId: "0",
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    try {
      await updateSetting("community_new_user_review_hours", 0, "0");
      await changeCommentStatus(
        pendingComment.id,
        "0",
        "published",
        "审核通过",
      );
    } finally {
      leaveTestContext();
    }
    const reply = await createComment(
      actorId,
      post.id,
      "现在可回复",
      pendingComment.id,
    );
    assertEquals(reply.status, "published");
    // 待审评论被批准后补发回复通知给原帖作者
    const notifications = await listNotifications(actorId);
    assertEquals(
      notifications.some((n) => n.notification.type === "reply"),
      true,
    );
    // 评论作者本人收到审核结果通知（moderation）
    const authorNotifications = await listNotifications(observerId);
    assertEquals(
      authorNotifications.some((n) => n.notification.type === "moderation"),
      true,
    );
    // 根评论（published）仍然可回复
    assertEquals(rootComment.status, "published");
  },
});

Deno.test({
  name: "community service: 评论点赞通知被赞者且校验评论存在",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const board = await createBoard({ slug: "like-board", name: "点赞板块" });
    const post = await createPost(actorId, {
      type: "discussion",
      board_id: board.id,
      title: "评论点赞测试",
      content: "内容",
    });
    const comment = await createComment(actorId, post.id, "待点赞评论");
    await assertRejects(
      () => toggleCommentLike(observerId, "not-exist-comment"),
      NotFoundError,
    );
    await toggleCommentLike(observerId, comment.id);
    const notifications = await listNotifications(actorId);
    assertEquals(
      notifications.some((n) => n.notification.type === "like"),
      true,
    );
    assertEquals(await toggleCommentLike(observerId, comment.id), false);
  },
});

Deno.test({
  name: "community service: 待审评论进入审核队列",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const board = await createBoard({
      slug: "pending-board",
      name: "待审板块",
    });
    const post = await createPost(actorId, {
      type: "discussion",
      board_id: board.id,
      title: "待审评论测试",
      content: "内容",
    });
    enterTestContext({
      actorId: "0",
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    try {
      await updateSetting("community_new_user_review_hours", 24, "0");
    } finally {
      leaveTestContext();
    }
    await createComment(observerId, post.id, "待审评论一");
    const pending = await listPendingComments();
    assertEquals(pending.length, 1);
    assertEquals(pending[0]?.author.id, observerId);
  },
});

Deno.test({
  name: "community service: 预审发布通知作者且处罚阻止社区写入",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const board = await createBoard({ slug: "review-board", name: "预审板块" });
    enterTestContext({
      actorId: "0",
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    try {
      await updateSetting("community_new_user_review_hours", 24, "0");
      const pendingPost = await createPost(actorId, {
        type: "discussion",
        board_id: board.id,
        title: "等待审核的讨论",
        content: "等待审核",
      });
      assertEquals(pendingPost.status, "pending");

      await changePostStatus(pendingPost.id, "0", "published", "审核通过");
      const notifications = await listNotifications(actorId);
      assertEquals(notifications[0]?.notification.type, "moderation");

      await createSanction("0", actorId, "测试禁言");
      await assertRejects(
        () => assertCommunityWritable(actorId, false),
        ForbiddenError,
        "你已被限制社区互动",
      );
    } finally {
      leaveTestContext();
    }
  },
});

Deno.test({
  name: "community service: 隐藏活动不进入他人的动态流，举报可处置且拒绝重复",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const board = await createBoard({ slug: "report-board", name: "举报板块" });
    const post = await createPost(actorId, {
      type: "discussion",
      board_id: board.id,
      title: "待举报讨论",
      content: "举报目标",
    });
    const report = await createReport(observerId, {
      post_id: post.id,
      reason: "测试原因",
      category: "违法违规",
    });
    await assertRejects(
      () =>
        createReport(observerId, {
          post_id: post.id,
          reason: "重复举报",
          category: "违法违规",
        }),
      ConflictError,
      "已举报该内容",
    );
    enterTestContext({
      actorId: "0",
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    try {
      const resolved = await resolveReport(
        report.id,
        "0",
        "resolved",
        "已处理",
      );
      assertEquals(resolved.status, "resolved");
    } finally {
      leaveTestContext();
    }
    const reports = await getDb().select().from(communityReports).where(
      eq(communityReports.id, report.id),
    );
    assertEquals(reports[0]?.resolution, "已处理");

    await createActivity(actorId, "first_accepted", "problem", "p-hidden", {});
    await updateActivityVisibility(actorId, "hidden");
    const feed = await listFeed("latest", observerId);
    assertEquals(feed.data.some((item) => item.kind === "activity"), false);
  },
});

Deno.test({
  name: "community service: 发布频率限制与题解门槛豁免审核员",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const board = await createBoard({ slug: "rate-board", name: "频率板块" });
    enterTestContext({
      actorId: "0",
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    try {
      await updateSetting("community_post_interval_seconds", 3600, "0");
    } finally {
      leaveTestContext();
    }
    await createPost(actorId, {
      type: "discussion",
      board_id: board.id,
      title: "首次发布",
      content: "内容",
    });
    await assertRejects(
      () =>
        createPost(actorId, {
          type: "discussion",
          board_id: board.id,
          title: "二次发布",
          content: "内容",
        }),
      ForbiddenError,
      "发布过于频繁，请稍后再试",
    );
    // 门槛开启：普通用户未通过不能发题解，审核员豁免
    enterTestContext({
      actorId: "0",
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    try {
      await updateSetting("community_solution_requires_accepted", true, "0");
      await updateSetting("community_post_interval_seconds", 0, "0");
    } finally {
      leaveTestContext();
    }
    await assertRejects(
      () =>
        createPost(actorId, {
          type: "solution",
          problem_id: "community-test-problem",
          title: "未通过题解",
          content: "内容",
        }),
      ForbiddenError,
      "通过对应题目后才能发布题解",
    );
    const moderatorPost = await createPost(
      actorId,
      {
        type: "solution",
        problem_id: "community-test-problem",
        title: "审核员题解",
        content: "内容",
      },
      true,
    );
    assertEquals(moderatorPost.status, "published");
  },
});

Deno.test({
  name: "community service: 作者可见自己的待审评论，模块关闭时详情 403",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const board = await createBoard({ slug: "vis-board", name: "可见板块" });
    const post = await createPost(actorId, {
      type: "discussion",
      board_id: board.id,
      title: "可见性测试",
      content: "内容",
    });
    enterTestContext({
      actorId: "0",
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    try {
      await updateSetting("community_new_user_review_hours", 24, "0");
    } finally {
      leaveTestContext();
    }
    const pending = await createComment(observerId, post.id, "我的待审评论");
    assertEquals(pending.status, "pending");
    // 作者本人可见自己的 pending 评论
    const own = await listComments(post.id, observerId);
    assertEquals(own.some((c) => c.comment.id === pending.id), true);
    // 其他用户不可见 pending 评论
    const others = await listComments(post.id, actorId);
    assertEquals(others.some((c) => c.comment.id === pending.id), false);
    // 关闭讨论模块后详情返回 FEATURE_DISABLED 403（configuration spec）
    enterTestContext({
      actorId: "0",
      actorIp: "127.0.0.1",
      actorRole: "admin",
    });
    try {
      await updateSetting("community_discussions_enabled", false, "0");
    } finally {
      leaveTestContext();
    }
    await assertRejects(() => getPost(post.id, observerId), ForbiddenError);
  },
});

Deno.test({
  name: "community service: 动态流复合游标翻页不重复不丢失",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    // 手动插入 3 条同 created_at 的 moment，验证 (created_at, id) 复合游标
    const createdAt = new Date().toISOString();
    const values = [1, 2, 3].map((i) => ({
      id: `feed-moment-${i}`,
      type: "moment" as const,
      author_id: actorId,
      problem_id: null,
      board_id: null,
      title: null,
      content: `短动态 ${i}`,
      status: "published" as const,
      is_locked: false,
      is_pinned: false,
      moderation_reason: null,
      published_at: createdAt,
      created_at: createdAt,
      updated_at: createdAt,
    }));
    await getDb().insert(communityPosts).values(values);
    const page1 = await listFeed("latest", undefined, undefined, 2);
    assertEquals(page1.data.length, 2);
    assertEquals(page1.next_cursor !== null, true);
    const page2 = await listFeed("latest", undefined, page1.next_cursor!, 2);
    assertEquals(page2.data.length, 1);
    const ids1 = new Set(
      page1.data.map((i) => (i.kind === "moment" ? i.post.id : i.activity.id)),
    );
    const ids2 = new Set(
      page2.data.map((i) => (i.kind === "moment" ? i.post.id : i.activity.id)),
    );
    for (const id of ids2) assertEquals(ids1.has(id), false);
  },
});

Deno.test({
  name: "community service: 点赞已删除评论返回 404",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const board = await createBoard({ slug: "del-board", name: "删除板块" });
    const post = await createPost(actorId, {
      type: "discussion",
      board_id: board.id,
      title: "删除测试",
      content: "内容",
    });
    const comment = await createComment(actorId, post.id, "将被删除");
    await deleteComment(comment.id, actorId, false);
    await assertRejects(
      () => toggleCommentLike(observerId, comment.id),
      NotFoundError,
    );
  },
});
