import { DEFAULT_DOMAIN_ID } from "../../../../../shared/workspace/types.ts";
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import {
  accountNotifications,
  auditLogs,
  communityPosts,
  communityReports,
  communitySanctions,
  problems,
  users,
} from "../../../../../shared/db/schema.ts";
import {
  enterTestContext,
  leaveTestContext,
} from "../../../../platform/system/index.ts";
import {
  applyCommunityPreset,
  assertCommunityWritable,
  changeCommentStatus,
  changePostStatus,
  createBoard,
  createComment,
  createPost,
  createReport,
  createSanction,
  deleteComment,
  getPost,
  listComments,
  listNotifications,
  listPendingComments,
  listPosts,
  resolveReport,
  updatePost,
} from "../../index.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../../../../shared/base/errors.ts";
import {
  _resetSystemSettingsForTest,
  initSystemSettings,
  updateSetting,
} from "../../../../platform/system/index.ts";
import { publishBaselineVersionForTest } from "../../../../../../tests/helper.ts";

const actorId = "community-test-user";
const observerId = "community-test-observer";

async function setup(): Promise<void> {
  await resetDbForTest();
  // resetDbForTest 会 TRUNCATE roles/community_boards，重新 seed 以保证 FK 与默认板块
  _resetSystemSettingsForTest();
  await initSystemSettings();
  const now = new Date().toISOString();
  await getDb().insert(users).values([
    {
      id: actorId,
      username: "community-test-user",
      email: "community-test@example.com",
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    },
    {
      id: observerId,
      username: "community-test-observer",
      email: "community-test-observer@example.com",
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    },
  ]);
  await getDb().insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id: "community-test-problem",
    title: "社区测试题目",
    description: "测试用题目",
    difficulty: "easy",
    runtime_config: {},
    number: 5001,
    created_at: now,
    updated_at: now,
  });
  await publishBaselineVersionForTest("community-test-problem");
  enterTestContext({ actorId: "0", actorIp: "127.0.0.1", actorRole: "admin" });
  try {
    await updateSetting("community_enabled", true, "0");
    await updateSetting("community_new_user_review_hours", 0, "0");
  } finally {
    leaveTestContext();
  }
}

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
      assertEquals(knowledgeConfig.comments_enabled, false);
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
    // 合法但不存在的来源题号统一返回 404。
    await assertRejects(
      () =>
        createPost(actorId, {
          type: "solution",
          problem_id: "999999",
          title: "不存在题解",
          content: "不应允许发布",
        }),
      NotFoundError,
      "域题库中不存在此题",
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
  name: "community service: 举报可处置且拒绝重复",
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
  name: "community service: 软删除帖子和评论会清空通知关联",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const board = await createBoard({
      slug: "notification-delete-board",
      name: "通知删除板块",
    });
    const post = await createPost(actorId, {
      type: "discussion",
      board_id: board.id,
      title: "通知目标清理",
      content: "内容",
    });
    const comment = await createComment(observerId, post.id, "评论");

    await deleteComment(comment.id, observerId, false);
    let notifications = await getDb().select({
      post_id: accountNotifications.post_id,
      comment_id: accountNotifications.comment_id,
    }).from(accountNotifications).where(
      eq(accountNotifications.recipient_id, actorId),
    );
    assertEquals(notifications, [{ post_id: null, comment_id: null }]);

    const secondComment = await createComment(
      observerId,
      post.id,
      "第二条评论",
    );
    await changeCommentStatus(
      secondComment.id,
      observerId,
      "deleted",
      "审核删除",
    );
    notifications = await getDb().select({
      post_id: accountNotifications.post_id,
      comment_id: accountNotifications.comment_id,
    }).from(accountNotifications).where(
      eq(accountNotifications.recipient_id, actorId),
    );
    assertEquals(notifications.length, 2);
    for (const notification of notifications) {
      assertEquals(notification, { post_id: null, comment_id: null });
    }

    const thirdComment = await createComment(
      observerId,
      post.id,
      "第三条评论",
    );
    await changePostStatus(post.id, observerId, "deleted", "测试删除");
    notifications = await getDb().select({
      post_id: accountNotifications.post_id,
      comment_id: accountNotifications.comment_id,
    }).from(accountNotifications).where(
      eq(accountNotifications.recipient_id, actorId),
    );
    assertEquals(notifications.length, 4);
    for (const notification of notifications) {
      assertEquals(notification, { post_id: null, comment_id: null });
    }
    assertEquals(thirdComment.post_id, post.id);
  },
});

Deno.test({
  name:
    "community service: 游标翻页时官方题解不在每页重复（排序键必须全部排除）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const createdAt = new Date().toISOString();
    const board = await createBoard({ slug: "cursor-board", name: "游标板块" });
    // 1 条官方 + 4 条普通，共 5 条；per_page=2 → 需翻 3 页
    await getDb().insert(communityPosts).values([
      {
        domain_id: DEFAULT_DOMAIN_ID,
        id: "cursor-official",
        type: "discussion" as const,
        author_id: actorId,
        problem_id: null,
        board_id: board.id,
        title: "官方置顶讨论",
        content: "官方置顶动态",
        status: "published" as const,
        is_locked: false,
        is_pinned: false,
        is_official: true,
        moderation_reason: null,
        published_at: createdAt,
        created_at: createdAt,
        updated_at: createdAt,
      },
      ...[1, 2, 3, 4].map((i) => ({
        domain_id: DEFAULT_DOMAIN_ID,
        id: `cursor-normal-${i}`,
        type: "discussion" as const,
        author_id: actorId,
        problem_id: null,
        board_id: board.id,
        title: `普通讨论 ${i}`,
        content: `普通动态 ${i}`,
        status: "published" as const,
        is_locked: false,
        is_pinned: false,
        is_official: false,
        moderation_reason: null,
        published_at: createdAt,
        created_at: createdAt,
        updated_at: createdAt,
      })),
    ]);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res = await listPosts({
        type: "discussion",
        limit: 2,
        cursor: cursor ?? undefined,
      });
      for (const row of res.data) seen.push(row.post.id);
      cursor = res.next_cursor;
      if (!cursor) break;
    }

    // 官方条目只在第一页出现一次
    assertEquals(seen.filter((id) => id === "cursor-official").length, 1);
    // 且不重复任何条目
    assertEquals(new Set(seen).size, seen.length);
    // 5 条全部被翻到，不丢失
    assertEquals(new Set(seen).size, 5);
  },
});

/**
 * 评审 #4 回归：排序含 is_official / is_pinned 而游标只沿 created_at 推进，
 * 第一页被置顶帖填满时，第二页会以"置顶帖的最后时间"过滤普通帖，
 * 导致其后仍有但**时间更近的普通帖**永久不可见。
 *
 * 上面那条用例只覆盖"官方帖不重复"，恰好因为官方帖与普通帖 created_at 相同才
 * 没暴露本缺陷（同刻时 `<` 过滤不会误伤）。本条用**置顶帖时间晚于普通帖**的
 * 真实排布钉死"静默丢失"。
 */
Deno.test({
  name: "community service(评审#4): 置顶帖填满首页后普通帖不被跳过",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const t0 = Date.parse("2026-01-10T12:00:00.000Z");
    const at = (minutesAgo: number) =>
      new Date(t0 - minutesAgo * 60_000).toISOString();
    const board = await createBoard({ slug: "page-board", name: "翻页板块" });
    const base = {
      type: "discussion" as const,
      author_id: actorId,
      problem_id: null,
      board_id: board.id,
      title: "翻页讨论",
      status: "published" as const,
      is_locked: false,
      moderation_reason: null,
      published_at: null,
      updated_at: at(0),
    };
    // 排布：N1/N2 最新，两条置顶帖居中，N3 最旧
    await getDb().insert(communityPosts).values([
      {
        domain_id: DEFAULT_DOMAIN_ID,
        ...base,
        id: "page-n1",
        content: "普通1",
        is_pinned: false,
        is_official: false,
        created_at: at(0),
      },
      {
        domain_id: DEFAULT_DOMAIN_ID,
        ...base,
        id: "page-n2",
        content: "普通2",
        is_pinned: false,
        is_official: false,
        created_at: at(1),
      },
      {
        domain_id: DEFAULT_DOMAIN_ID,
        ...base,
        id: "page-p1",
        content: "置顶1",
        is_pinned: true,
        is_official: false,
        created_at: at(2),
      },
      {
        domain_id: DEFAULT_DOMAIN_ID,
        ...base,
        id: "page-p2",
        content: "置顶2",
        is_pinned: true,
        is_official: false,
        created_at: at(3),
      },
      {
        domain_id: DEFAULT_DOMAIN_ID,
        ...base,
        id: "page-n3",
        content: "普通3",
        is_pinned: false,
        is_official: false,
        created_at: at(4),
      },
    ]);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page++) {
      const res = await listPosts({
        type: "discussion",
        limit: 2,
        cursor: cursor ?? undefined,
      });
      for (const row of res.data) seen.push(row.post.id);
      cursor = res.next_cursor;
      if (!cursor) break;
    }

    // 修复前：page-n1 / page-n2 被跳过，seen 里没有它们（只剩 p1/p2/n3）
    assertEquals(new Set(seen).has("page-n1"), true);
    assertEquals(new Set(seen).has("page-n2"), true);
    // 5 条全部且各仅一次
    assertEquals(new Set(seen).size, 5);
    assertEquals(seen.length, 5);
  },
});

Deno.test({
  name: "community service: 未验证邮箱的账号不得产出内容（审计 F2）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const unverifiedId = "community-test-unverified";
    const now = new Date().toISOString();
    await getDb().insert(users).values({
      id: unverifiedId,
      username: "community-test-unverified",
      email: "community-test-unverified@example.com",
      password_hash: "hash",
      email_verified: false,
      created_at: now,
      updated_at: now,
    });
    try {
      // 政策绑定在写能力闸口上：旧入口与域入口（withDomainCommunity）共用
      const error = await assertRejects(
        () => assertCommunityWritable(unverifiedId, false),
        ForbiddenError,
      );
      assertEquals(
        (error as { code?: string }).code,
        "EMAIL_VERIFICATION_REQUIRED",
      );
      // 托管员不豁免（与旧中间件按路径拦截的口径一致）
      await assertRejects(
        () => assertCommunityWritable(unverifiedId, true),
        ForbiddenError,
      );
      // 已验证账号不受影响
      await assertCommunityWritable(actorId, false);
    } finally {
      leaveTestContext();
    }
  },
});
