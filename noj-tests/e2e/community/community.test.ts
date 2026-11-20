import { assertEquals } from "jsr:@std/assert@^1.0.13";
import {
  api,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  e2eTest,
  getAdminToken,
  isE2E,
  registerUser,
  TEST_PASSWORD,
  waitForServer,
} from "../helper.ts";

let authorToken = "";
let responderToken = "";
let adminToken = "";
let boardId = "";
let domainId = "";
let postId = "";
const suffix = Date.now().toString(36);
const slug = `community-${suffix}`;
const community = `/api/v1/domains/${slug}/community`;

async function joinDomain(token: string, email: string): Promise<void> {
  const invited = await apiPost(`/api/v1/domains/${slug}/invitations`, {
    email,
  }, adminToken);
  if (invited.status !== 201) {
    throw new Error(`域邀请失败: ${JSON.stringify(invited.body)}`);
  }
  const joined = await apiPost("/api/v1/domain-invitations/accept", {
    token: (invited.body as { data: { token: string } }).data.token,
  }, token);
  if (joined.status !== 200) {
    throw new Error(`加入社区域失败: ${JSON.stringify(joined.body)}`);
  }
}

e2eTest("[e2e/community] 准备两个社区用户和默认板块", async () => {
  if (!isE2E) return;
  await waitForServer();
  adminToken = await getAdminToken();
  const preset = await apiPost(
    "/api/v1/admin/community/preset/public",
    {},
    adminToken,
  );
  if (preset.status !== 200) {
    throw new Error(`应用公开社区预设失败: ${preset.status}`);
  }
  // 旧预审用例失败可能留下24小时窗口；该旅程明确准备无预审发布，最后一项独立验证预审并恢复。
  const reviewReset = await apiPut(
    "/api/v1/admin/system/settings/community_new_user_review_hours",
    { value: 0 },
    adminToken,
  );
  assertEquals(reviewReset.status, 200, "准备直接发布社区夹具");
  const domain = await apiPost("/api/v1/domains", {
    slug,
    name: `独立社区 ${suffix}`,
    preset: "community",
  }, adminToken);
  if (domain.status !== 201) {
    throw new Error(`建社区域失败: ${JSON.stringify(domain.body)}`);
  }
  domainId = (domain.body as { data: { id: string } }).data.id;
  authorToken = await registerUser(
    `community_author_${suffix}`,
    `community_author_${suffix}@test.com`,
    TEST_PASSWORD,
  );
  responderToken = await registerUser(
    `community_responder_${suffix}`,
    `community_responder_${suffix}@test.com`,
    TEST_PASSWORD,
  );
  await joinDomain(authorToken, `community_author_${suffix}@test.com`);
  await joinDomain(responderToken, `community_responder_${suffix}@test.com`);
  const createdBoard = await apiPost(`${community}/manage/boards`, {
    slug: "discussion",
    name: "独立讨论板块",
  }, adminToken);
  if (createdBoard.status !== 201) {
    throw new Error(`建板块失败: ${JSON.stringify(createdBoard.body)}`);
  }
  boardId = (createdBoard.body as { data: { id: string } }).data.id;
  const boards = await apiGet(`${community}/boards`, authorToken);
  if (boards.status !== 200) {
    throw new Error(`板块读取失败: ${boards.status}`);
  }
  if (
    !(boards.body as { data: Array<{ id: string }> }).data.some((board) =>
      board.id === boardId
    )
  ) {
    throw new Error("未找到独立域板块");
  }
});

e2eTest("[e2e/community] 发布、互动、治理、通知与软删除主流程", async () => {
  if (!isE2E) return;
  const created = await apiPost(
    `${community}/posts`,
    {
      type: "discussion",
      board_id: boardId,
      title: "E2E 社区讨论",
      content: "测试社区发布流程",
    },
    authorToken,
  );
  if (created.status !== 201) {
    throw new Error(
      `发布失败: ${created.status} ${JSON.stringify(created.body)}`,
    );
  }
  postId = (created.body as { data: { id: string; status: string } }).data.id;

  const listed = await apiGet(
    `${community}/posts?type=discussion`,
    responderToken,
  );
  const posts = (listed.body as { data: Array<{ post: { id: string } }> }).data;
  if (
    listed.status !== 200 || !posts.some((item) => item.post.id === postId)
  ) {
    throw new Error("已发布讨论未出现在列表中");
  }
  const filtered = await apiGet(
    `${community}/posts?type=discussion&q=${
      encodeURIComponent("E2E 社区讨论")
    }`,
    responderToken,
  );
  const filteredPosts = (filtered.body as {
    data: Array<{ post: { id: string } }>;
  }).data;
  if (
    filtered.status !== 200 ||
    !filteredPosts.some((item) => item.post.id === postId)
  ) {
    throw new Error("社区标题搜索未返回已发布讨论");
  }
  const indexDeadline = Date.now() + 30000;
  let indexed = false;
  while (Date.now() < indexDeadline) {
    const search = await apiGet(
      `/api/v1/domains/${slug}/search?q=E2E&type=community_post`,
      responderToken,
    );
    assertEquals(search.status, 200);
    const posts =
      (search.body as { data: { items: { entity_id: string }[] } }).data.items;
    if (posts.some((item) => item.entity_id === postId)) {
      indexed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assertEquals(indexed, true, "当前域搜索应在持久事件入索引后返回已发布讨论");

  const comment = await apiPost(
    `${community}/posts/${postId}/comments`,
    { content: "这是一条 E2E 回复" },
    responderToken,
  );
  if (comment.status !== 201) throw new Error(`评论失败: ${comment.status}`);

  const notifications = await apiGet(
    `/api/v1/notifications?domain_id=${domainId}`,
    authorToken,
  );
  const entries = (notifications.body as {
    data: Array<{ notification: { type: string } }>;
  }).data;
  if (
    notifications.status !== 200 ||
    !entries.some((item) => item.notification.type === "reply")
  ) {
    throw new Error("作者未收到回复通知");
  }

  const unread = await apiGet(
    `/api/v1/notifications?domain_id=${domainId}&per_page=1`,
    authorToken,
  );
  assertEquals(unread.status, 200);
  if ((unread.body as { unread_count: number }).unread_count < 1) {
    throw new Error("作者未收到回复通知");
  }
  const markedRead = await apiPost(
    `/api/v1/notifications/read?domain_id=${domainId}`,
    {},
    authorToken,
  );
  if (markedRead.status !== 204) throw new Error("通知标记已读失败");

  const report = await apiPost(
    `${community}/reports`,
    { post_id: postId, reason: "E2E 举报处置测试", category: "垃圾信息" },
    responderToken,
  );
  if (report.status !== 201) throw new Error(`举报失败: ${report.status}`);
  const reportId = (report.body as { data: { id: string } }).data.id;
  const resolved = await api(
    "PATCH",
    `${community}/manage/reports/${reportId}`,
    {
      body: { status: "resolved", resolution: "E2E 已处理" },
      token: adminToken,
    },
  );
  if (resolved.status !== 200) {
    throw new Error(`处理举报失败: ${resolved.status}`);
  }

  const deleted = await apiDelete(
    `${community}/posts/${postId}`,
    authorToken,
  );
  if (deleted.status !== 200) {
    throw new Error(`软删除失败: ${deleted.status}`);
  }
  const afterDelete = await apiGet(
    `${community}/posts?type=discussion`,
    responderToken,
  );
  const remaining = (afterDelete.body as {
    data: Array<{ post: { id: string } }>;
  }).data;
  if (
    afterDelete.status !== 200 ||
    remaining.some((item) => item.post.id === postId)
  ) {
    throw new Error("已删除讨论仍出现在普通列表中");
  }
});

e2eTest("[e2e/community] 新用户评论进入预审并可被管理员批准", async () => {
  if (!isE2E) return;
  const admin = await getAdminToken();
  // 先创建讨论帖（此时未开启预审 → 立即发布），避免 root 也被视为新用户
  const boards = await apiGet(`${community}/boards`, admin);
  const boardList = (boards.body as { data: Array<{ id: string }> }).data;
  const post = await apiPost(
    `${community}/posts`,
    {
      type: "discussion",
      board_id: boardList[0]?.id,
      title: "E2E 待审评论帖",
      content: "正文",
    },
    admin,
  );
  if (post.status !== 201) throw new Error(`管理员发帖失败: ${post.status}`);
  const postId = (post.body as { data: { id: string } }).data.id;

  // 保存原审核配置，失败也恢复，避免后续 E2E 被预审夹具污染。
  const settings = await apiGet("/api/v1/admin/system/settings", admin);
  if (settings.status !== 200) {
    throw new Error(`读取设置失败: ${settings.status}`);
  }
  const original =
    (settings.body as { data: { key: string; effective_value: unknown }[] })
      .data
      .find((item) => item.key === "community_new_user_review_hours");
  if (!original) throw new Error("缺少新用户审核设置");
  // 再开启新用户预审窗口
  const setReview = await apiPut(
    "/api/v1/admin/system/settings/community_new_user_review_hours",
    { value: 24 },
    admin,
  );
  if (setReview.status !== 200) {
    throw new Error(`开启预审失败: ${setReview.status}`);
  }

  try {
    // 新注册用户评论 → pending
    const suffix = Date.now().toString(36) + "c";
    const cToken = await registerUser(
      `comment_${suffix}`,
      `comment_${suffix}@test.com`,
      TEST_PASSWORD,
    );
    await joinDomain(cToken, `comment_${suffix}@test.com`);
    const comment = await apiPost(
      `${community}/posts/${postId}/comments`,
      { content: "E2E 待审评论" },
      cToken,
    );
    if (comment.status !== 201) throw new Error(`评论失败: ${comment.status}`);
    const commentData = (comment.body as {
      data: { id: string; status: string };
    }).data;
    if (commentData.status !== "pending") {
      throw new Error("新用户评论未进入预审");
    }
    const commentId = commentData.id;

    // 管理员待审队列包含该评论
    const pending = await apiGet(
      `${community}/manage/comments`,
      admin,
    );
    const pendingList = (pending.body as {
      data: Array<{ comment: { id: string } }>;
    }).data;
    if (
      pending.status !== 200 ||
      !pendingList.some((item) => item.comment.id === commentId)
    ) {
      throw new Error("待审评论未出现在管理员队列");
    }

    // 管理员批准 → 帖子作者（管理员）收到回复通知
    const approve = await api(
      "PATCH",
      `${community}/manage/comments/${commentId}/status`,
      {
        body: { status: "published", reason: "E2E 审核通过" },
        token: admin,
      },
    );
    if (approve.status !== 200) {
      throw new Error(`批准评论失败: ${approve.status}`);
    }
    const notifications = await apiGet(
      `/api/v1/notifications?domain_id=${domainId}`,
      admin,
    );
    const entries = (notifications.body as {
      data: Array<{ notification: { type: string } }>;
    }).data;
    if (!entries.some((item) => item.notification.type === "reply")) {
      throw new Error("批准待审评论后作者未收到回复通知");
    }
  } finally {
    const restored = await apiPut(
      "/api/v1/admin/system/settings/community_new_user_review_hours",
      { value: original.effective_value },
      admin,
    );
    assertEquals(restored.status, 200, "恢复新用户审核设置");
  }
});
