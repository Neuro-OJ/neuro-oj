import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  getAdminToken,
  isE2E,
  registerUser,
  waitForServer,
  e2eTest,
  TEST_PASSWORD,

} from "./helper.ts";

let authorToken = "";
let responderToken = "";
let adminToken = "";
let boardId = "";
let postId = "";

e2eTest("[e2e/community] 准备两个社区用户和默认板块", async () => {
    if (!isE2E) return;
    await waitForServer();
    adminToken = await getAdminToken();
    const preset = await apiPost(
      "/api/v1/community/admin/preset/public",
      {},
      adminToken,
    );
    if (preset.status !== 200) {
      throw new Error(`应用公开社区预设失败: ${preset.status}`);
    }
    const suffix = Date.now().toString(36);
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
    const boards = await apiGet("/api/v1/community/boards", authorToken);
    if (boards.status !== 200) {
      throw new Error(`板块读取失败: ${boards.status}`);
    }
    boardId = (boards.body as { data: Array<{ id: string }> }).data[0]?.id ??
      "";
    if (!boardId) throw new Error("未找到默认社区板块");
  });

e2eTest("[e2e/community] 发布、互动、治理、通知与软删除主流程", async () => {
    if (!isE2E) return;
    const created = await apiPost(
      "/api/v1/community/posts",
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
      "/api/v1/community/posts?type=discussion",
      responderToken,
    );
    const posts =
      (listed.body as { data: Array<{ post: { id: string } }> }).data;
    if (
      listed.status !== 200 || !posts.some((item) => item.post.id === postId)
    ) {
      throw new Error("已发布讨论未出现在列表中");
    }
    const filtered = await apiGet(
      `/api/v1/community/posts?type=discussion&q=${
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
    const globalSearch = await apiGet(
      "/api/v1/search?q=E2E&type=community",
      responderToken,
    );
    const globalPosts = (globalSearch.body as {
      data: { items: Array<{ id: string }> };
    }).data.items;
    if (
      globalSearch.status !== 200 ||
      !globalPosts.some((item) => item.id === postId)
    ) {
      throw new Error("全局帖子搜索未返回已发布讨论");
    }

    const comment = await apiPost(
      `/api/v1/community/posts/${postId}/comments`,
      { content: "这是一条 E2E 回复" },
      responderToken,
    );
    if (comment.status !== 201) throw new Error(`评论失败: ${comment.status}`);

    const liked = await apiPost(
      `/api/v1/community/posts/${postId}/like`,
      {},
      responderToken,
    );
    if (liked.status !== 200) throw new Error(`点赞失败: ${liked.status}`);

    const bookmarked = await apiPost(
      `/api/v1/community/posts/${postId}/bookmark`,
      {},
      responderToken,
    );
    if (bookmarked.status !== 200) {
      throw new Error(`收藏失败: ${bookmarked.status}`);
    }
    const bookmarks = await apiGet(
      "/api/v1/community/bookmarks",
      responderToken,
    );
    const savedPosts = (bookmarks.body as {
      data: Array<{ post: { id: string } }>;
    }).data;
    if (
      bookmarks.status !== 200 ||
      !savedPosts.some((item) => item.post.id === postId)
    ) {
      throw new Error("收藏内容未出现在个人收藏列表中");
    }
    const detail = await apiGet(
      `/api/v1/community/posts/${postId}`,
      responderToken,
    );
    if (
      detail.status !== 200 ||
      (detail.body as { data: { bookmarked: boolean } }).data.bookmarked !==
        true
    ) {
      throw new Error("帖子详情未标记当前用户已收藏");
    }

    // responder 关注帖子作者（生成关注通知；原实现为残缺坏代码，此处按 267 行
    // 动态流测试的既有模式补全：先取作者 id 再 POST follow）
    const authorMe = await apiGet("/api/v1/auth/me", authorToken);
    const authorId = (authorMe.body as { data: { id: string } }).data.id;
    const followed = await apiPost(
      `/api/v1/community/users/${authorId}/follow`,
      {},
      responderToken,
    );
    if (followed.status !== 200) throw new Error(`关注失败: ${followed.status}`);

    const notifications = await apiGet(
      "/api/v1/community/notifications",
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
      "/api/v1/community/notifications/unread-count",
      authorToken,
    );
    const unreadCount = (unread.body as { data: { unread_count: number } }).data
      .unread_count;
    if (unread.status !== 200 || unreadCount < 3) {
      throw new Error("作者未收到互动与关注通知");
    }
    const markedRead = await apiPost(
      "/api/v1/community/notifications/read",
      {},
      authorToken,
    );
    if (markedRead.status !== 204) throw new Error("通知标记已读失败");

    const report = await apiPost(
      "/api/v1/community/reports",
      { post_id: postId, reason: "E2E 举报处置测试", category: "垃圾信息" },
      responderToken,
    );
    if (report.status !== 201) throw new Error(`举报失败: ${report.status}`);
    const reportId = (report.body as { data: { id: string } }).data.id;
    const resolved = await apiPost(
      `/api/v1/community/admin/reports/${reportId}/resolved`,
      { resolution: "E2E 已处理" },
      adminToken,
    );
    if (resolved.status !== 200) {
      throw new Error(`处理举报失败: ${resolved.status}`);
    }

    const deleted = await apiDelete(
      `/api/v1/community/posts/${postId}`,
      authorToken,
    );
    if (deleted.status !== 200) {
      throw new Error(`软删除失败: ${deleted.status}`);
    }
    const afterDelete = await apiGet(
      "/api/v1/community/posts?type=discussion",
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
    const bookmarksAfterDelete = await apiGet(
      "/api/v1/community/bookmarks",
      responderToken,
    );
    const remainingBookmarks = (bookmarksAfterDelete.body as {
      data: Array<{ post: { id: string } }>;
    }).data;
    if (
      bookmarksAfterDelete.status !== 200 ||
      remainingBookmarks.some((item) => item.post.id === postId)
    ) {
      throw new Error("已删除讨论仍出现在个人收藏列表中");
    }
  }
);

e2eTest("[e2e/community] 关注动态流：已关注用户发布的短动态进入关注流", async () => {
    if (!isE2E) return;
    const suffix = Date.now().toString(36) + "f";
    const aToken = await registerUser(
      `feed_a_${suffix}`,
      `feed_a_${suffix}@test.com`,
      TEST_PASSWORD,
    );
    const bToken = await registerUser(
      `feed_b_${suffix}`,
      `feed_b_${suffix}@test.com`,
      TEST_PASSWORD,
    );
    const aMe = await apiGet("/api/v1/auth/me", aToken);
    const aId = (aMe.body as { data: { id: string } }).data.id;

    // b 关注 a
    const follow = await apiPost(
      `/api/v1/community/users/${aId}/follow`,
      {},
      bToken,
    );
    if (follow.status !== 200) throw new Error(`关注失败: ${follow.status}`);

    // a 发布短动态
    const moment = await apiPost(
      "/api/v1/community/posts",
      { type: "moment", content: "E2E 关注流短动态" },
      aToken,
    );
    if (moment.status !== 201) {
      throw new Error(`发布动态失败: ${moment.status}`);
    }
    const momentId = (moment.body as { data: { id: string } }).data.id;

    // b 的关注流包含该动态
    const feed = await apiGet("/api/v1/community/feed?view=following", bToken);
    const items = (feed.body as {
      data: Array<{ kind: string; post?: { id: string } }>;
    }).data;
    if (
      feed.status !== 200 ||
      !items.some((item) =>
        item.kind === "moment" && item.post?.id === momentId
      )
    ) {
      throw new Error("已关注用户的短动态未出现在关注流中");
    }
  });

e2eTest("[e2e/community] 新用户评论进入预审并可被管理员批准", async () => {
    if (!isE2E) return;
    const admin = await getAdminToken();
    // 先创建讨论帖（此时未开启预审 → 立即发布），避免 root 也被视为新用户
    const boards = await apiGet("/api/v1/community/boards", admin);
    const boardList = (boards.body as { data: Array<{ id: string }> }).data;
    const post = await apiPost(
      "/api/v1/community/posts",
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

    // 再开启新用户预审窗口
    const setReview = await apiPut(
      "/api/v1/admin/settings/community_new_user_review_hours",
      { value: 24 },
      admin,
    );
    if (setReview.status !== 200) {
      throw new Error(`开启预审失败: ${setReview.status}`);
    }

    // 新注册用户评论 → pending
    const suffix = Date.now().toString(36) + "c";
    const cToken = await registerUser(
      `comment_${suffix}`,
      `comment_${suffix}@test.com`,
      TEST_PASSWORD,
    );
    const comment = await apiPost(
      `/api/v1/community/posts/${postId}/comments`,
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
      "/api/v1/community/admin/comments/pending",
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
    const approve = await apiPost(
      `/api/v1/community/admin/comments/${commentId}/published`,
      { reason: "E2E 审核通过" },
      admin,
    );
    if (approve.status !== 200) {
      throw new Error(`批准评论失败: ${approve.status}`);
    }
    const notifications = await apiGet(
      "/api/v1/community/notifications",
      admin,
    );
    const entries = (notifications.body as {
      data: Array<{ notification: { type: string } }>;
    }).data;
    if (!entries.some((item) => item.notification.type === "reply")) {
      throw new Error("批准待审评论后作者未收到回复通知");
    }

    // 恢复默认，避免影响后续用例
    await apiPut(
      "/api/v1/admin/settings/community_new_user_review_hours",
      { value: 0 },
      admin,
    );
  });
