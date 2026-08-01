import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { createApp } from "../../src/app.ts";
import { signToken } from "../../src/lib/jwt.ts";
import {
  communityBoards,
  permissions,
  problems,
  rolePermissions,
  userRoles,
  users,
} from "../../src/db/schema.ts";
import {
  _resetSystemSettingsForTest,
  initSystemSettings,
  updateSetting,
} from "../../src/services/system-settings.ts";
import { ensureRbacSeeds } from "../../src/services/seed-rbac.ts";
import {
  enterTestContext,
  leaveTestContext,
} from "../../src/lib/requestContext.ts";
import { jsonRequest } from "../lib/helper.ts";

if (!Deno.env.get("JWT_SECRET")) {
  Deno.env.set(
    "JWT_SECRET",
    "community-route-test-secret-at-least-32-characters",
  );
}
Deno.env.set("NOJ_BYPASS_JWT_REVOKE", "1");

const authorId = "community-route-author";
const responderId = "community-route-responder";

async function setup(): Promise<void> {
  await resetDbForTest();
  // resetDbForTest 会 TRUNCATE roles/community_boards，重新 seed 以保证 FK 与默认板块
  await ensureRbacSeeds();
  _resetSystemSettingsForTest();
  await initSystemSettings();
  const now = new Date().toISOString();
  // author 为「老用户」（用于预审场景：其内容即时发布），responder 为「新用户」
  const old = new Date(Date.now() - 30 * 86400_000).toISOString();
  await getDb().insert(users).values([
    {
      id: authorId,
      username: authorId,
      email: `${authorId}@test.com`,
      password_hash: "hash",
      role: "user",
      created_at: old,
      updated_at: old,
    },
    {
      id: responderId,
      username: responderId,
      email: `${responderId}@test.com`,
      password_hash: "hash",
      role: "user",
      created_at: now,
      updated_at: now,
    },
  ]);
  await getDb().insert(userRoles).values([
    { user_id: authorId, role_id: "user" },
    { user_id: responderId, role_id: "user" },
  ]);
  await getDb().insert(problems).values({
    id: "community-search-problem",
    title: "社区搜索关联题目",
    description: "社区搜索测试题目",
    difficulty: "easy",
    runtime_config: {},
    number: 9999,
    type: "P",
    created_at: now,
    updated_at: now,
  });
  enterTestContext({
    actorId: "0",
    actorIp: "127.0.0.1",
    actorRole: "admin",
  });
  try {
    await updateSetting("community_solution_requires_accepted", false, "0");
  } finally {
    leaveTestContext();
  }
}

Deno.test({
  name: "community route: 私域预设下游客读取内容返回 401",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const app = createApp();
    const response = await jsonRequest(app, "/api/v1/community/posts");
    assertEquals(response.status, 401);
  },
});

Deno.test({
  name: "community route: 写入需要登录且普通用户可创建讨论",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const app = createApp();
    const board = (await getDb().select().from(communityBoards))[0];
    const body = {
      type: "discussion",
      board_id: board?.id,
      title: "路由测试讨论",
      content: "通过 HTTP 创建讨论",
    };
    const unauthorized = await jsonRequest(app, "/api/v1/community/posts", {
      method: "POST",
      body,
    });
    assertEquals(unauthorized.status, 401);

    const authorToken = await signToken({ sub: authorId, role: "user" });
    const created = await jsonRequest(app, "/api/v1/community/posts", {
      method: "POST",
      body,
      token: authorToken,
    });
    assertEquals(created.status, 201);
    const createdBody = await created.json();
    assertEquals(createdBody.data.status, "published");
  },
});

Deno.test({
  name: "community route: 帖子可按题目、标题和正文搜索",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const app = createApp();
    const board = (await getDb().select().from(communityBoards))[0];
    const authorToken = await signToken({ sub: authorId, role: "user" });
    const discussion = await jsonRequest(app, "/api/v1/community/posts", {
      method: "POST",
      token: authorToken,
      body: {
        type: "discussion",
        board_id: board?.id,
        title: "标题检索词",
        content: "正文检索词",
      },
    });
    const discussionId = (await discussion.json()).data.id as string;
    const solution = await jsonRequest(app, "/api/v1/community/posts", {
      method: "POST",
      token: authorToken,
      body: {
        type: "solution",
        problem_id: "community-search-problem",
        title: "关联题目题解",
        content: "关联题目检索内容",
      },
    });
    const solutionId = (await solution.json()).data.id as string;

    const titleResult = await jsonRequest(
      app,
      "/api/v1/community/posts?type=discussion&q=标题检索词",
      { token: authorToken },
    );
    assertEquals(
      (await titleResult.json()).data.some(
        (item: { post: { id: string } }) => item.post.id === discussionId,
      ),
      true,
    );
    const contentResult = await jsonRequest(
      app,
      "/api/v1/community/posts?type=discussion&q=正文检索词",
      { token: authorToken },
    );
    assertEquals(
      (await contentResult.json()).data.some(
        (item: { post: { id: string } }) => item.post.id === discussionId,
      ),
      true,
    );
    const problemResult = await jsonRequest(
      app,
      "/api/v1/community/posts?problem_id=community-search-problem",
      { token: authorToken },
    );
    assertEquals(
      (await problemResult.json()).data.some(
        (item: { post: { id: string } }) => item.post.id === solutionId,
      ),
      true,
    );
  },
});

Deno.test({
  name: "community route: 通知未读数可标记已读，管理接口拒绝普通用户",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const app = createApp();
    const board = (await getDb().select().from(communityBoards))[0];
    const authorToken = await signToken({ sub: authorId, role: "user" });
    const responderToken = await signToken({ sub: responderId, role: "user" });
    const created = await jsonRequest(app, "/api/v1/community/posts", {
      method: "POST",
      token: authorToken,
      body: {
        type: "discussion",
        board_id: board?.id,
        title: "通知目标讨论",
        content: "等待回复",
      },
    });
    const postId = (await created.json()).data.id as string;
    const comment = await jsonRequest(
      app,
      `/api/v1/community/posts/${postId}/comments`,
      { method: "POST", token: responderToken, body: { content: "回复" } },
    );
    assertEquals(comment.status, 201);

    const unread = await jsonRequest(
      app,
      "/api/v1/community/notifications/unread-count",
      { token: authorToken },
    );
    assertEquals((await unread.json()).data.unread_count, 1);
    const read = await jsonRequest(
      app,
      "/api/v1/community/notifications/read",
      {
        method: "POST",
        token: authorToken,
      },
    );
    assertEquals(read.status, 204);
    const afterRead = await jsonRequest(
      app,
      "/api/v1/community/notifications/unread-count",
      { token: authorToken },
    );
    assertEquals((await afterRead.json()).data.unread_count, 0);

    const forbidden = await jsonRequest(
      app,
      "/api/v1/community/admin/reports",
      {
        token: responderToken,
      },
    );
    assertEquals(forbidden.status, 403);
  },
});

Deno.test({
  name: "community route: 用户仅能读取自己的可见收藏",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const app = createApp();
    const board = (await getDb().select().from(communityBoards))[0];
    const authorToken = await signToken({ sub: authorId, role: "user" });
    const responderToken = await signToken({ sub: responderId, role: "user" });
    const created = await jsonRequest(app, "/api/v1/community/posts", {
      method: "POST",
      token: authorToken,
      body: {
        type: "discussion",
        board_id: board?.id,
        title: "收藏路由测试",
        content: "用于验证个人收藏列表",
      },
    });
    const postId = (await created.json()).data.id as string;
    const bookmarked = await jsonRequest(
      app,
      `/api/v1/community/posts/${postId}/bookmark`,
      { method: "POST", token: responderToken },
    );
    assertEquals(bookmarked.status, 200);

    const detail = await jsonRequest(
      app,
      `/api/v1/community/posts/${postId}`,
      { token: responderToken },
    );
    assertEquals((await detail.json()).data.bookmarked, true);

    const unauthorized = await jsonRequest(app, "/api/v1/community/bookmarks");
    assertEquals(unauthorized.status, 401);
    const listed = await jsonRequest(app, "/api/v1/community/bookmarks", {
      token: responderToken,
    });
    const body = await listed.json();
    assertEquals(listed.status, 200);
    assertEquals(
      body.data.map((item: { post: { id: string } }) => item.post.id),
      [postId],
    );
  },
});

Deno.test({
  name: "community route: 关闭动态模块后动态列表返回 FEATURE_DISABLED",
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
      await updateSetting("community_moments_enabled", false, "0");
    } finally {
      leaveTestContext();
    }
    const app = createApp();
    const response = await jsonRequest(
      app,
      "/api/v1/community/posts?type=moment",
    );
    assertEquals(response.status, 403);
    const body = await response.json();
    assertEquals(body.code, "FEATURE_DISABLED");
  },
});

Deno.test({
  name: "community route: 帖子计数按类型返回已发布数量",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const app = createApp();
    const board = (await getDb().select().from(communityBoards))[0];
    const authorToken = await signToken({ sub: authorId, role: "user" });
    await jsonRequest(app, "/api/v1/community/posts", {
      method: "POST",
      token: authorToken,
      body: {
        type: "discussion",
        board_id: board?.id,
        title: "计数讨论",
        content: "用于计数",
      },
    });
    await jsonRequest(app, "/api/v1/community/posts", {
      method: "POST",
      token: authorToken,
      body: {
        type: "solution",
        problem_id: "community-search-problem",
        title: "计数题解",
        content: "用于计数",
      },
    });
    const counts = await jsonRequest(app, "/api/v1/community/posts/counts", {
      token: authorToken,
    });
    assertEquals(counts.status, 200);
    assertEquals(await counts.json(), {
      data: { solution: 1, discussion: 1, moment: 0 },
    });
  },
});

Deno.test({
  name: "community route: 单条通知已读仅限本人且幂等",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const app = createApp();
    const board = (await getDb().select().from(communityBoards))[0];
    const authorToken = await signToken({ sub: authorId, role: "user" });
    const responderToken = await signToken({ sub: responderId, role: "user" });
    const created = await jsonRequest(app, "/api/v1/community/posts", {
      method: "POST",
      token: authorToken,
      body: {
        type: "discussion",
        board_id: board?.id,
        title: "单条已读讨论",
        content: "触发回复通知",
      },
    });
    const postId = (await created.json()).data.id as string;
    await jsonRequest(
      app,
      `/api/v1/community/posts/${postId}/comments`,
      { method: "POST", token: responderToken, body: { content: "单条回复" } },
    );

    const notifications = await jsonRequest(
      app,
      "/api/v1/community/notifications",
      { token: authorToken },
    );
    const notificationId = (await notifications.json()).data[0].notification
      .id as string;

    // 未登录 401
    const anonymous = await jsonRequest(
      app,
      `/api/v1/community/notifications/${notificationId}/read`,
      { method: "POST" },
    );
    assertEquals(anonymous.status, 401);

    // 他人通知 404
    const others = await jsonRequest(
      app,
      `/api/v1/community/notifications/${notificationId}/read`,
      { method: "POST", token: responderToken },
    );
    assertEquals(others.status, 404);

    // 本人已读成功 → 未读数清零，重复调用幂等
    const read = await jsonRequest(
      app,
      `/api/v1/community/notifications/${notificationId}/read`,
      { method: "POST", token: authorToken },
    );
    assertEquals(read.status, 204);
    const again = await jsonRequest(
      app,
      `/api/v1/community/notifications/${notificationId}/read`,
      { method: "POST", token: authorToken },
    );
    assertEquals(again.status, 204);
    const unread = await jsonRequest(
      app,
      "/api/v1/community/notifications/unread-count",
      { token: authorToken },
    );
    assertEquals((await unread.json()).data.unread_count, 0);
  },
});

Deno.test({
  name: "community route: 评论仅作者可编辑删除且删除后不可见",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const app = createApp();
    const board = (await getDb().select().from(communityBoards))[0];
    const authorToken = await signToken({ sub: authorId, role: "user" });
    const responderToken = await signToken({ sub: responderId, role: "user" });
    const created = await jsonRequest(app, "/api/v1/community/posts", {
      method: "POST",
      token: authorToken,
      body: {
        type: "discussion",
        board_id: board?.id,
        title: "评论治理讨论",
        content: "验证评论编辑与删除",
      },
    });
    const postId = (await created.json()).data.id as string;
    const comment = await jsonRequest(
      app,
      `/api/v1/community/posts/${postId}/comments`,
      { method: "POST", token: responderToken, body: { content: "原始评论" } },
    );
    const commentId = (await comment.json()).data.id as string;

    // 他人编辑 403
    const forbiddenEdit = await jsonRequest(
      app,
      `/api/v1/community/comments/${commentId}`,
      { method: "PATCH", token: authorToken, body: { content: "越权编辑" } },
    );
    assertEquals(forbiddenEdit.status, 403);

    // 作者编辑成功
    const edited = await jsonRequest(
      app,
      `/api/v1/community/comments/${commentId}`,
      {
        method: "PATCH",
        token: responderToken,
        body: { content: "修改后评论" },
      },
    );
    assertEquals(edited.status, 200);
    assertEquals((await edited.json()).data.content, "修改后评论");

    // 他人删除 403
    const forbiddenDelete = await jsonRequest(
      app,
      `/api/v1/community/comments/${commentId}`,
      { method: "DELETE", token: authorToken },
    );
    assertEquals(forbiddenDelete.status, 403);

    // 作者删除成功，列表不再返回
    const deleted = await jsonRequest(
      app,
      `/api/v1/community/comments/${commentId}`,
      { method: "DELETE", token: responderToken },
    );
    assertEquals(deleted.status, 200);
    const comments = await jsonRequest(
      app,
      `/api/v1/community/posts/${postId}/comments`,
      { token: responderToken },
    );
    assertEquals((await comments.json()).data.length, 0);

    // 编辑已删除评论 400
    const editDeleted = await jsonRequest(
      app,
      `/api/v1/community/comments/${commentId}`,
      { method: "PATCH", token: responderToken, body: { content: "再编辑" } },
    );
    assertEquals(editDeleted.status, 400);

    // 不存在 404
    const missing = await jsonRequest(
      app,
      "/api/v1/community/comments/not-exist",
      { method: "DELETE", token: responderToken },
    );
    assertEquals(missing.status, 404);
  },
});

Deno.test({
  name: "community route: 单用户处罚历史含已撤销记录且仅管理员可读",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const app = createApp();
    const adminToken = await signToken({
      sub: "0",
      role: "admin",
      is_admin: true,
    });
    const userToken = await signToken({ sub: authorId, role: "user" });
    const created = await jsonRequest(
      app,
      "/api/v1/community/admin/sanctions",
      {
        method: "POST",
        token: adminToken,
        body: { user_id: authorId, reason: "测试禁言", expires_at: null },
      },
    );
    const sanctionId = (await created.json()).data.id as string;
    await jsonRequest(app, "/api/v1/community/admin/sanctions", {
      method: "POST",
      token: adminToken,
      body: { user_id: authorId, reason: "二次禁言", expires_at: null },
    });
    await jsonRequest(
      app,
      `/api/v1/community/admin/sanctions/${sanctionId}`,
      { method: "DELETE", token: adminToken },
    );

    // 普通用户 403
    const forbidden = await jsonRequest(
      app,
      `/api/v1/community/admin/users/${authorId}/sanctions`,
      { token: userToken },
    );
    assertEquals(forbidden.status, 403);

    // 管理员可见全部记录（含已撤销）
    const history = await jsonRequest(
      app,
      `/api/v1/community/admin/users/${authorId}/sanctions`,
      { token: adminToken },
    );
    const entries = (await history.json()).data as Array<{
      id: string;
      revoked_at: string | null;
    }>;
    assertEquals(history.status, 200);
    assertEquals(entries.length, 2);
    assertEquals(
      entries.filter((item) => item.revoked_at !== null).length,
      1,
    );

    // 无处罚用户返回空数组
    const empty = await jsonRequest(
      app,
      `/api/v1/community/admin/users/${responderId}/sanctions`,
      { token: adminToken },
    );
    assertEquals(await empty.json(), { data: [] });
  },
});

Deno.test({
  name: "community route: 通知 SSE 端点需要登录",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const app = createApp();
    const anonymous = await jsonRequest(
      app,
      "/api/v1/community/notifications/events",
    );
    assertEquals(anonymous.status, 401);
  },
});

Deno.test({
  name: "community route: 关注动态流仅包含已关注用户的内容且游客不可见",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const app = createApp();
    const authorToken = await signToken({ sub: authorId, role: "user" });
    const responderToken = await signToken({ sub: responderId, role: "user" });

    // 私域预设下游客访问关注流 401
    const guest = await jsonRequest(
      app,
      "/api/v1/community/feed?view=following",
    );
    assertEquals(guest.status, 401);

    // author 发一条短动态
    const moment = await jsonRequest(app, "/api/v1/community/posts", {
      method: "POST",
      token: authorToken,
      body: { type: "moment", content: "关注流里的短动态" },
    });
    assertEquals(moment.status, 201);
    const momentId = (await moment.json()).data.id as string;

    // 未关注时 responder 的关注流为空
    const emptyFeed = await jsonRequest(
      app,
      "/api/v1/community/feed?view=following",
      { token: responderToken },
    );
    assertEquals((await emptyFeed.json()).data.length, 0);

    // responder 关注 author 后，关注流出现该动态
    const followed = await jsonRequest(
      app,
      `/api/v1/community/users/${authorId}/follow`,
      { method: "POST", token: responderToken },
    );
    assertEquals(followed.status, 200);
    const feed = await jsonRequest(
      app,
      "/api/v1/community/feed?view=following",
      { token: responderToken },
    );
    assertEquals(feed.status, 200);
    const feedData = (await feed.json()).data as Array<{
      kind: string;
      post: { id: string };
    }>;
    assertEquals(
      feedData.some(
        (item) => item.kind === "moment" && item.post.id === momentId,
      ),
      true,
    );
  },
});

Deno.test({
  name: "community route: 管理员可查看并批准待审评论，普通用户无权访问队列",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    // 开启新用户预审窗口
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
    const app = createApp();
    const adminToken = await signToken({
      sub: "0",
      role: "admin",
      is_admin: true,
    });
    const authorToken = await signToken({ sub: authorId, role: "user" });
    const responderToken = await signToken({ sub: responderId, role: "user" });

    const board = (await getDb().select().from(communityBoards))[0];
    const created = await jsonRequest(app, "/api/v1/community/posts", {
      method: "POST",
      token: authorToken,
      body: {
        type: "discussion",
        board_id: board?.id,
        title: "待审评论测试",
        content: "正文",
      },
    });
    const postId = (await created.json()).data.id as string;

    // 新用户评论进入 pending
    const comment = await jsonRequest(
      app,
      `/api/v1/community/posts/${postId}/comments`,
      { method: "POST", token: responderToken, body: { content: "待审评论" } },
    );
    assertEquals(comment.status, 201);
    const commentBody = (await comment.json()) as {
      data: { id: string; status: string };
    };
    const commentId = commentBody.data.id;
    assertEquals(commentBody.data.status, "pending");

    // 普通用户访问待审评论队列 403
    const forbidden = await jsonRequest(
      app,
      "/api/v1/community/admin/comments/pending",
      { token: responderToken },
    );
    assertEquals(forbidden.status, 403);

    // 管理员可见待审评论
    const pending = await jsonRequest(
      app,
      "/api/v1/community/admin/comments/pending",
      { token: adminToken },
    );
    assertEquals(pending.status, 200);
    const pendingList = (await pending.json()).data as Array<{
      comment: { id: string };
    }>;
    assertEquals(
      pendingList.some((item) => item.comment.id === commentId),
      true,
    );

    // 批准后帖子作者收到回复通知
    const approve = await jsonRequest(
      app,
      `/api/v1/community/admin/comments/${commentId}/published`,
      { method: "POST", token: adminToken, body: { reason: "审核通过" } },
    );
    assertEquals(approve.status, 200);
    const notifications = await jsonRequest(
      app,
      "/api/v1/community/notifications",
      { token: authorToken },
    );
    const entries = (await notifications.json()).data as Array<{
      notification: { type: string };
    }>;
    assertEquals(
      entries.some((item) => item.notification.type === "reply"),
      true,
    );
  },
});

Deno.test({
  name: "community route: 题解发布资格端点返回模块开关、门槛与 Accepted 状态",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const app = createApp();
    const authorToken = await signToken({ sub: authorId, role: "user" });
    // 门槛已关闭（setup）：直接可创建
    const response = await jsonRequest(
      app,
      "/api/v1/community/solutions/eligibility?problem_id=community-search-problem",
      { token: authorToken },
    );
    assertEquals(response.status, 200);
    const body = (await response.json()).data as {
      enabled: boolean;
      requires_accepted: boolean;
      accepted: boolean;
      can_create: boolean;
    };
    assertEquals(body.enabled, true);
    assertEquals(body.requires_accepted, false);
    assertEquals(body.accepted, true);
    assertEquals(body.can_create, true);
    // 题目不存在 → 404
    const missing = await jsonRequest(
      app,
      "/api/v1/community/solutions/eligibility?problem_id=not-exist",
      { token: authorToken },
    );
    assertEquals(missing.status, 404);
    // 未登录 → 401
    const guest = await jsonRequest(
      app,
      "/api/v1/community/solutions/eligibility?problem_id=community-search-problem",
    );
    assertEquals(guest.status, 401);
  },
});

Deno.test({
  name: "community route: 发布频率限制返回 POST_RATE_LIMITED 403",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const app = createApp();
    const authorToken = await signToken({ sub: authorId, role: "user" });
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
    const board = (await getDb().select().from(communityBoards))[0];
    const body = {
      type: "discussion",
      board_id: board?.id,
      title: "频率测试",
      content: "内容",
    };
    const first = await jsonRequest(app, "/api/v1/community/posts", {
      method: "POST",
      body,
      token: authorToken,
    });
    assertEquals(first.status, 201);
    const second = await jsonRequest(app, "/api/v1/community/posts", {
      method: "POST",
      body,
      token: authorToken,
    });
    assertEquals(second.status, 403);
    const errorBody = await second.json();
    assertEquals(errorBody.code, "POST_RATE_LIMITED");
  },
});

Deno.test({
  name: "community route: 社区管理端点按 moderation 权限而非仅 admin 开放",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const app = createApp();
    const authorToken = await signToken({ sub: authorId, role: "user" });
    // 普通用户（无 moderation 权限）访问待审评论队列 → 403
    const forbidden = await jsonRequest(
      app,
      "/api/v1/community/admin/comments/pending",
      { token: authorToken },
    );
    assertEquals(forbidden.status, 403);
    // 未登录 → 401
    const guest = await jsonRequest(
      app,
      "/api/v1/community/admin/comments/pending",
    );
    assertEquals(guest.status, 401);
  },
});

Deno.test({
  name: "community route: 具备 moderation 权限的审核员可访问社区管理端点",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setup();
    const app = createApp();
    // 给 responder 所在 user 角色授予 community_moderation:review
    const permRows = await getDb().select({ id: permissions.id }).from(
      permissions,
    ).where(
      and(
        eq(permissions.resource, "community_moderation"),
        eq(permissions.action, "review"),
      ),
    ).limit(1);
    if (permRows[0]) {
      await getDb().insert(rolePermissions).values({
        role_id: "user",
        permission_id: permRows[0].id,
      }).onConflictDoNothing();
    }
    const responderToken = await signToken({
      sub: responderId,
      role: "user",
    });
    const response = await jsonRequest(
      app,
      "/api/v1/community/admin/comments/pending",
      { token: responderToken },
    );
    assertEquals(response.status, 200);
    // 板块管理仍需 community_board:manage（审核员无此权限 → 403）
    const boardForbidden = await jsonRequest(
      app,
      "/api/v1/community/admin/boards",
      { method: "POST", token: responderToken, body: { slug: "x", name: "X" } },
    );
    assertEquals(boardForbidden.status, 403);
  },
});
