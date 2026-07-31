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
}

export interface CommunityPostInput {
  type: CommunityPostType;
  title?: string;
  content: string;
  problem_id?: string;
  board_id?: string;
}
