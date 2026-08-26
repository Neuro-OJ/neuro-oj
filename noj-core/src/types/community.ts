export const COMMUNITY_POST_TYPES = [
  "solution",
  "discussion",
  "moment",
] as const;
export type CommunityPostType = (typeof COMMUNITY_POST_TYPES)[number];

export const COMMUNITY_POST_STATUSES = [
  "draft",
  "pending",
  "published",
  "hidden",
  "deleted",
] as const;
export type CommunityPostStatus = (typeof COMMUNITY_POST_STATUSES)[number];

/** 内容审核可切换的状态（路由层参数校验用）。 */
export const MODERATION_STATUSES = [
  "published",
  "hidden",
  "deleted",
] as const;

/** 举报分类（用户侧必选，工单/后台展示）。 */
export const REPORT_CATEGORIES = [
  "违法违规",
  "人身侵权",
  "涉嫌欺诈",
  "侵权抄袭",
  "垃圾信息",
  "站外风险引流",
  "AI生成内容问题",
  "其他",
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/** 社区预设（admin 路由参数校验用）。 */
export const COMMUNITY_PRESETS = [
  "public",
  "private",
  "knowledge",
] as const;

export interface CommunityConfig {
  enabled: boolean;
  guest_read_enabled: boolean;
  read_only: boolean;
  solutions_enabled: boolean;
  discussions_enabled: boolean;
  moments_enabled: boolean;
  activities_enabled: boolean;
  comments_enabled: boolean;
  reactions_enabled: boolean;
  bookmarks_enabled: boolean;
  follows_enabled: boolean;
  private_messaging_enabled: boolean;
  external_images_enabled: boolean;
  solution_requires_accepted: boolean;
  new_user_review_hours: number;
  post_max_length: number;
  moment_max_length: number;
  comment_max_length: number;
  post_interval_seconds: number;
}

export interface CommunityPostInput {
  type: CommunityPostType;
  title?: string;
  content: string;
  problem_id?: string;
  board_id?: string;
}
