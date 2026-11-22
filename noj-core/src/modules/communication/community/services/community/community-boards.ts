import { and, eq } from "drizzle-orm";
import { communityBoards } from "../../../../../shared/db/schema.ts";
import { NotFoundError } from "../../../../../shared/base/errors.ts";
import { nowIso } from "../../../../../shared/base/dates.ts";
import {
  communityDb,
  communityDomainId,
  communityDomainWhere,
  type CommunityScope,
} from "./community-scope.ts";

/**
 * 列出社区板块。
 * @param includeArchived 是否包含已归档板块，默认 false（仅返回未归档板块）。
 * @returns 按 sort_order、created_at 排序的板块列表。
 */
export function listBoards(includeArchived = false, scope?: CommunityScope) {
  const db = communityDb(scope);
  return db.select().from(communityBoards)
    .where(
      and(
        communityDomainWhere(communityBoards.domain_id, scope),
        includeArchived ? undefined : eq(communityBoards.is_archived, false),
      ),
    )
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
  scope?: CommunityScope,
) {
  const db = communityDb(scope);
  const createdAt = nowIso();
  const board = {
    id: crypto.randomUUID(),
    domain_id: communityDomainId(scope),
    revision: 0,
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
  scope?: CommunityScope,
) {
  const db = communityDb(scope);
  const rows = await db.update(communityBoards).set({
    ...input,
    updated_at: nowIso(),
  }).where(
    and(
      eq(communityBoards.id, id),
      communityDomainWhere(communityBoards.domain_id, scope),
    ),
  ).returning();
  if (!rows[0]) throw new NotFoundError("板块不存在");
  return rows[0];
}
