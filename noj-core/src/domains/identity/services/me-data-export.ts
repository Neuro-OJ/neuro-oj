/**
 * 个人信息导出（PIPL 第 45 条：查阅、复制权）。
 *
 * 聚合用户自身的账户、提交、社区内容与同意记录，返回 JSON。
 * 仅导出**本人**数据；不含他人信息。
 */

import { desc, eq } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import {
  communityComments,
  communityPosts,
  evaluationResults,
  submissions,
  userConsents,
  users,
} from "./../../../shared/db/schema.ts";

/** 导出包结构。 */
export interface UserDataExport {
  exported_at: string;
  account: {
    id: string;
    username: string;
    email: string;
    bio: string;
    avatar_url: string | null;
    email_verified: boolean;
    created_at: string;
    updated_at: string;
  };
  submissions: Array<{
    id: string;
    problem_id: string;
    language: string;
    code: string;
    status: string;
    created_at: string;
    score: number | null;
  }>;
  community: {
    posts: Array<{
      id: string;
      type: string;
      title: string | null;
      content: string;
      created_at: string;
    }>;
    comments: Array<{
      id: string;
      post_id: string;
      content: string;
      created_at: string;
    }>;
  };
  consents: Array<{
    document_kind: string;
    version: number;
    agreed_at: string;
  }>;
}

/**
 * 构建某用户的数据导出包。
 *
 * @param userId 用户 id
 * @returns 导出包；用户不存在时返回 null
 */
export async function buildUserDataExport(
  userId: string,
): Promise<UserDataExport | null> {
  const db = getDb();
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;

  const subs = await db
    .select({
      id: submissions.id,
      problem_id: submissions.problem_id,
      language: submissions.language,
      code: submissions.code,
      status: submissions.status,
      created_at: submissions.created_at,
      score: evaluationResults.score,
    })
    .from(submissions)
    .leftJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    )
    .where(eq(submissions.user_id, userId))
    .orderBy(desc(submissions.created_at));

  const posts = await db
    .select({
      id: communityPosts.id,
      type: communityPosts.type,
      title: communityPosts.title,
      content: communityPosts.content,
      created_at: communityPosts.created_at,
    })
    .from(communityPosts)
    .where(eq(communityPosts.author_id, userId));

  const comments = await db
    .select({
      id: communityComments.id,
      post_id: communityComments.post_id,
      content: communityComments.content,
      created_at: communityComments.created_at,
    })
    .from(communityComments)
    .where(eq(communityComments.author_id, userId));

  const consents = await db
    .select({
      document_kind: userConsents.document_kind,
      version: userConsents.version,
      agreed_at: userConsents.agreed_at,
    })
    .from(userConsents)
    .where(eq(userConsents.user_id, userId));

  return {
    exported_at: new Date().toISOString(),
    account: {
      id: user.id,
      username: user.username,
      email: user.email,
      bio: user.bio,
      avatar_url: user.avatar_url,
      email_verified: user.email_verified,
      created_at: user.created_at,
      updated_at: user.updated_at,
    },
    submissions: subs,
    community: { posts, comments },
    consents,
  };
}
