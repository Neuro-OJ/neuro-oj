import { and, eq } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { communityBoardRoleGrants, communityBoards } from "../db/schema.ts";
import { NotFoundError } from "../lib/errors.ts";
import { nowIso } from "../lib/dates.ts";

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
