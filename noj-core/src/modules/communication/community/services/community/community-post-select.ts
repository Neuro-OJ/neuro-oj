import { sql } from "drizzle-orm";
import { communityPosts, users } from "../../../../../shared/db/schema.ts";

/**
 * 社区内容作者投影（id / username / avatar_url）。
 * 在帖子、评论、动态等查询中复用，避免重复定义。
 */
export const authorProjection = {
  id: users.id,
  username: users.username,
  avatar_url: users.avatar_url,
} as const;

/**
 * 帖子评论数投影。
 * 用于帖子列表与详情查询。
 */
export const postStatsProjection = {
  comments: sql<
    number
  >`(select count(*)::int from community_comments where post_id = ${communityPosts.id} and status = 'published')`,
} as const;
