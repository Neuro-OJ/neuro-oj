import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db/connection.ts";
import {
  communityBoardRoleGrants,
  communityBoards,
} from "../../../../db/schema.ts";
import { NotFoundError } from "./../../../../shared/base/errors.ts";
import { nowIso } from "./../../../../shared/base/dates.ts";

/**
 * 列出社区板块。
 * @param includeArchived 是否包含已归档板块，默认 false（仅返回未归档板块）。
 * @returns 按 sort_order、created_at 排序的板块列表。
 */
export function listBoards(includeArchived = false) {
  const db = getDb();
  return db.select().from(communityBoards)
    .where(includeArchived ? undefined : eq(communityBoards.is_archived, false))
    .orderBy(communityBoards.sort_order, communityBoards.created_at);
}

/**
 * 创建社区板块。
 * @param input 板块输入：slug（唯一标识）、name（名称）、description（描述）、sort_order（排序权重）。
 * @returns 新建的板块记录。
 */
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

/**
 * 更新社区板块（名称、描述、排序、归档状态等）。
 * @param id 板块 UUID。
 * @param input 需要更新的字段（部分可选）。
 * @returns 更新后的板块记录。
 * @throws {NotFoundError} 板块不存在时抛出。
 */
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

/**
 * 列出指定板块的角色授权记录。
 * @param boardId 板块 UUID。
 * @returns 该板块的角色授权列表。
 */
export function listBoardRoleGrants(boardId: string) {
  const db = getDb();
  return db.select().from(communityBoardRoleGrants).where(
    eq(communityBoardRoleGrants.board_id, boardId),
  );
}

/**
 * 更新（或创建）板块的角色授权：已存在则按 (board_id, role_id) 更新，否则插入。
 * @param boardId 板块 UUID。
 * @param roleId 角色 UUID。
 * @param input 授权字段：can_read（可读）、can_post（可发帖）、can_moderate（可管理）。
 * @returns 更新后的角色授权记录。
 */
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

/**
 * 删除板块的角色授权记录。
 * @param boardId 板块 UUID。
 * @param roleId 角色 UUID。
 */
export async function deleteBoardRoleGrant(boardId: string, roleId: string) {
  const db = getDb();
  await db.delete(communityBoardRoleGrants).where(and(
    eq(communityBoardRoleGrants.board_id, boardId),
    eq(communityBoardRoleGrants.role_id, roleId),
  ));
}
