import { sql } from "drizzle-orm";
import { communityPosts, users } from "./../../../../shared/db/schema.ts";

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
 * 帖子点赞/评论数投影。
 * 用于帖子列表、详情、收藏等查询。
 */
export const postStatsProjection = {
  likes: sql<
    number
  >`(select count(*) from community_post_likes where post_id = ${communityPosts.id})`,
  comments: sql<
    number
  >`(select count(*) from community_comments where post_id = ${communityPosts.id} and status = 'published')`,
} as const;
