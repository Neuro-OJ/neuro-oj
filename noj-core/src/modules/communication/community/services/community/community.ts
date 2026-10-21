/**
 * 社区服务 barrel 入口。
 *
 * 原单文件 community.ts 已拆分为：
 * - community-config.ts        配置 功能开关
 * - community-boards.ts        板块 角色授权
 * - community-post-common.ts   帖子辅助（类型映射/题目解析/门槛判定）
 * - community-post-crud.ts     帖子增删改查（create/get/update）
 * - community-post-list.ts     帖子列表与收藏（list/count/bookmarks）
 * - community-post-moderation.ts 帖子审核处置（改状态/锁/置顶）
 * - community-comments.ts      评论
 * - community-interactions.ts  点赞/收藏/关注
 * - community-feed.ts          动态流与通知
 * - community-moderation.ts    举报/处罚/预设
 */
export {
  assertCommunityEnabled,
  assertCommunityWritable,
  getCommunityConfig,
} from "./community-config.ts";
export {
  createBoard,
  deleteBoardRoleGrant,
  listBoardRoleGrants,
  listBoards,
  updateBoard,
  updateBoardRoleGrant,
} from "./community-boards.ts";
export {
  assertNotContestSilenced,
  featureForType,
  hasAcceptedSolution,
  notGatedContestContent,
  publicationStatus,
  resolveProblemId,
} from "./community-post-common.ts";
export {
  createPost,
  getPost,
  resolvePostId,
  setPostOfficial,
  updatePost,
} from "./community-post-crud.ts";
export {
  countPostsByType,
  listBookmarks,
  listPosts,
} from "./community-post-list.ts";
export {
  changePostStatus,
  togglePostFlag,
} from "./community-post-moderation.ts";
export {
  changeCommentStatus,
  createComment,
  deleteComment,
  listComments,
  listPendingComments,
  updateComment,
} from "./community-comments.ts";
export {
  toggleBookmark,
  toggleCommentLike,
  toggleFollow,
  togglePostLike,
} from "./community-interactions.ts";
export {
  getNotification,
  getNotificationUnreadCount,
  listFeed,
  listNotifications,
  markNotificationRead,
  markNotificationsRead,
  notificationVisibleWhere,
} from "./community-feed.ts";
export {
  applyCommunityPreset,
  banUser,
  createReport,
  createSanction,
  getLatestActiveBanId,
  getReportBanScope,
  getReportDetail,
  getReportImageBytes,
  getReportMessageHistory,
  getReportTarget,
  listReports,
  listSanctions,
  listUserSanctions,
  reopenReport,
  resolveReport,
  revokeSanction,
} from "./community-moderation.ts";
export { parseQueryLimit } from "./query-limit.ts";
