/**
 * community 配置子域：板块管理 + 资格校验 + 配置读取。
 * 对应 OpenSpec spec: openspec/specs/community-configuration/spec.md
 *
 * 跨子域依赖：本文件导出 getCommunityConfig / assertCommunityEnabled /
 * resolveProblemId / hasAcceptedSolution 等公开函数，被 ./community-content.ts
 * 大量调用（创建帖子、查询、评论、互动等动作的入口处）。
 */

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  communityBoardRoleGrants,
  communityBoards,
  communitySanctions,
  evaluationResults,
  problems,
  submissions,
} from "../db/schema.ts";
import { ForbiddenError, NotFoundError } from "../lib/errors.ts";
import { getSetting } from "./system-settings.ts";
import type { CommunityConfig } from "../types/community.ts";
import { nowIso } from "../lib/dates.ts";

function settingBoolean(key: string): boolean {
  return getSetting(key)?.value === true;
}

function settingNumber(key: string): number {
  const value = Number(getSetting(key)?.value);
  return Number.isFinite(value) ? value : 0;
}

export function getCommunityConfig(): CommunityConfig {
  return {
    enabled: settingBoolean("community_enabled"),
    guest_read_enabled: settingBoolean("community_guest_read_enabled"),
    read_only: settingBoolean("community_read_only"),
    solutions_enabled: settingBoolean("community_solutions_enabled"),
    discussions_enabled: settingBoolean("community_discussions_enabled"),
    moments_enabled: settingBoolean("community_moments_enabled"),
    activities_enabled: settingBoolean("community_activities_enabled"),
    comments_enabled: settingBoolean("community_comments_enabled"),
    reactions_enabled: settingBoolean("community_reactions_enabled"),
    bookmarks_enabled: settingBoolean("community_bookmarks_enabled"),
    follows_enabled: settingBoolean("community_follows_enabled"),
    private_messaging_enabled: settingBoolean("private_messaging_enabled"),
    external_images_enabled: settingBoolean(
      "community_external_images_enabled",
    ),
    solution_requires_accepted: settingBoolean(
      "community_solution_requires_accepted",
    ),
    new_user_review_hours: settingNumber("community_new_user_review_hours"),
    post_max_length: settingNumber("community_post_max_length"),
    moment_max_length: settingNumber("community_moment_max_length"),
    comment_max_length: settingNumber("community_comment_max_length"),
    post_interval_seconds: settingNumber("community_post_interval_seconds"),
  };
}

export function assertCommunityEnabled(
  feature?: keyof CommunityConfig,
): void {
  const config = getCommunityConfig();
  if (!config.enabled || (feature && config[feature] === false)) {
    throw new ForbiddenError("该社区功能已关闭", "FEATURE_DISABLED");
  }
}

export async function assertCommunityWritable(
  userId: string,
  isModerator: boolean,
): Promise<void> {
  const config = getCommunityConfig();
  if (config.read_only && !isModerator) {
    throw new ForbiddenError("社区当前为只读模式", "COMMUNITY_READ_ONLY");
  }
  if (isModerator) return;
  const db = getDb();
  const rows = await db.select().from(communitySanctions).where(and(
    eq(communitySanctions.user_id, userId),
    isNull(communitySanctions.revoked_at),
  )).limit(1);
  const sanction = rows[0];
  if (sanction && (!sanction.expires_at || sanction.expires_at > nowIso())) {
    throw new ForbiddenError("你已被限制社区互动", "COMMUNITY_SANCTIONED", {
      reason: sanction.reason,
      until: sanction.expires_at,
    });
  }
}

export async function resolveProblemId(
  reference: string,
): Promise<string | null> {
  const db = getDb();
  // 按 problems.id 主键查找（UUID 或旧 seed 的数字 id）
  const findByPk = async (id: string): Promise<string | null> => {
    const row = await db.select({ id: problems.id }).from(problems)
      .where(eq(problems.id, id)).limit(1);
    return row[0]?.id ?? null;
  };
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(reference)) {
    return findByPk(reference);
  }
  const match = reference.match(/^([UuPp])(\d+)$/);
  if (match) {
    const row = await db.select({ id: problems.id }).from(problems).where(and(
      eq(problems.type, match[1].toUpperCase()),
      eq(problems.number, parseInt(match[2], 10)),
    )).limit(1);
    return row[0]?.id ?? null;
  }
  // 纯数字：先按 PK 查找（旧 seed 数据 1001/1002/1003 以数字为 id），再按 type=P+number 兜底
  if (/^\d+$/.test(reference)) {
    const byPk = await findByPk(reference);
    if (byPk) return byPk;
    const fallback = await db.select({ id: problems.id }).from(problems)
      .where(and(
        eq(problems.type, "P"),
        eq(problems.number, parseInt(reference, 10)),
      )).limit(1);
    return fallback[0]?.id ?? null;
  }
  // 兜底：其余格式按 PK 尝试
  return findByPk(reference);
}

/** 查询用户是否已 Accepted 指定题目（供门槛判定与题解发布入口使用）。 */
export async function hasAcceptedSolution(
  authorId: string,
  problemId: string,
): Promise<boolean> {
  const db = getDb();
  const rows = await db.select({ id: submissions.id }).from(submissions)
    .innerJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    )
    .where(and(
      eq(submissions.user_id, authorId),
      eq(submissions.problem_id, problemId),
      eq(evaluationResults.status, "Accepted"),
    )).limit(1);
  return !!rows[0];
}

export function listBoards(includeArchived = false) {
  const db = getDb();
  return db.select().from(communityBoards)
    .where(includeArchived ? undefined : eq(communityBoards.is_archived, false))
    .orderBy(communityBoards.sort_order, communityBoards.created_at);
}

export async function createBoard(
  input: {
    slug: string;
    name: string;
    description?: string;
    sort_order?: number;
  },
) {
  const db = getDb();
  const createdAt = nowIso();
  const board = {
    id: crypto.randomUUID(),
    slug: input.slug,
    name: input.name,
    description: input.description ?? "",
    sort_order: input.sort_order ?? 0,
    is_archived: false,
    created_at: createdAt,
    updated_at: createdAt,
  };
  await db.insert(communityBoards).values(board);
  return board;
}

export async function updateBoard(
  id: string,
  input: Partial<
    {
      name: string;
      description: string;
      sort_order: number;
      is_archived: boolean;
    }
  >,
) {
  const db = getDb();
  const rows = await db.update(communityBoards).set({
    ...input,
    updated_at: nowIso(),
  }).where(eq(communityBoards.id, id)).returning();
  if (!rows[0]) throw new NotFoundError("板块不存在");
  return rows[0];
}

export function listBoardRoleGrants(boardId: string) {
  const db = getDb();
  return db.select().from(communityBoardRoleGrants).where(
    eq(communityBoardRoleGrants.board_id, boardId),
  );
}

export async function updateBoardRoleGrant(
  boardId: string,
  roleId: string,
  input: { can_read?: boolean; can_post?: boolean; can_moderate?: boolean },
) {
  const db = getDb();
  await db.insert(communityBoardRoleGrants).values({
    board_id: boardId,
    role_id: roleId,
    can_read: input.can_read ?? true,
    can_post: input.can_post ?? false,
    can_moderate: input.can_moderate ?? false,
  }).onConflictDoUpdate({
    target: [
      communityBoardRoleGrants.board_id,
      communityBoardRoleGrants.role_id,
    ],
    set: input,
  });
  const rows = await db.select().from(communityBoardRoleGrants).where(and(
    eq(communityBoardRoleGrants.board_id, boardId),
    eq(communityBoardRoleGrants.role_id, roleId),
  )).limit(1);
  return rows[0]!;
}

export async function deleteBoardRoleGrant(boardId: string, roleId: string) {
  const db = getDb();
  await db.delete(communityBoardRoleGrants).where(and(
    eq(communityBoardRoleGrants.board_id, boardId),
    eq(communityBoardRoleGrants.role_id, roleId),
  ));
}
