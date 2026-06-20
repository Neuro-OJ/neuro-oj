import { asc, eq } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import { categories } from "../db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../lib/errors.ts";

/**
 * 分类响应（树形节点）。
 */
export interface CategoryTreeNode {
  id: string;
  name: string;
  slug: string;
  description: string;
  parent_id: string | null;
  level: number;
  children: CategoryTreeNode[];
  created_at: string;
  updated_at: string;
}

export interface CreateCategoryInput {
  name: string;
  slug: string;
  description?: string;
  parent_id?: string;
}

export interface UpdateCategoryInput {
  name?: string;
  slug?: string;
  description?: string;
  parent_id?: string | null;
}

/**
 * 将数据库行转换为树节点。
 */
function toNode(row: typeof categories.$inferSelect): CategoryTreeNode {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    parent_id: row.parent_id,
    level: row.level,
    children: [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 从扁平行列表构建树形结构。
 */
function buildTree(rows: typeof categories.$inferSelect[]): CategoryTreeNode[] {
  const map = new Map<string, CategoryTreeNode>();
  const roots: CategoryTreeNode[] = [];

  // 先转换为节点
  for (const row of rows) {
    map.set(row.id, toNode(row));
  }

  // 组装父子关系
  for (const node of map.values()) {
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id)!.children.push(node);
    } else if (!node.parent_id) {
      roots.push(node);
    }
  }

  // 按 ID 排序保持稳定顺序
  roots.sort((a, b) => a.id.localeCompare(b.id));

  return roots;
}

/**
 * 获取分类树（所有分类按层级嵌套）。
 */
export async function listCategories(): Promise<CategoryTreeNode[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(categories)
    .orderBy(asc(categories.id));

  return buildTree(rows);
}

/**
 * 根据 ID 获取单条分类（不含子分类）。
 *
 * @throws {NotFoundError} 分类不存在
 */
export async function getCategory(id: string): Promise<CategoryTreeNode> {
  const db = getDb();

  const row = await db
    .select()
    .from(categories)
    .where(eq(categories.id, id))
    .limit(1);

  if (row.length === 0) {
    throw new NotFoundError("分类不存在");
  }

  return toNode(row[0]);
}

/**
 * 创建分类。
 *
 * @throws {ConflictError} slug 已存在
 * @throws {BadRequestError} 父分类不存在
 */
export async function createCategory(
  input: CreateCategoryInput,
): Promise<CategoryTreeNode> {
  const db = getDb();

  // 检查 slug 唯一性
  const existingSlug = await db
    .select()
    .from(categories)
    .where(eq(categories.slug, input.slug))
    .limit(1);

  if (existingSlug.length > 0) {
    throw new ConflictError("分类标识 slug 已存在");
  }

  // 计算 level
  let level = 0;
  if (input.parent_id) {
    const parent = await db
      .select()
      .from(categories)
      .where(eq(categories.id, input.parent_id))
      .limit(1);

    if (parent.length === 0) {
      throw new BadRequestError("父分类不存在");
    }
    level = parent[0].level + 1;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(categories).values({
    id,
    name: input.name,
    slug: input.slug,
    description: input.description ?? "",
    parent_id: input.parent_id ?? null,
    level,
    created_at: now,
    updated_at: now,
  });

  return {
    id,
    name: input.name,
    slug: input.slug,
    description: input.description ?? "",
    parent_id: input.parent_id ?? null,
    level,
    children: [],
    created_at: now,
    updated_at: now,
  };
}

/**
 * 更新分类。
 *
 * @throws {NotFoundError} 分类不存在
 * @throws {ConflictError} slug 已被其他分类使用
 * @throws {BadRequestError} 父分类不存在 或 形成循环引用
 */
export async function updateCategory(
  id: string,
  input: UpdateCategoryInput,
): Promise<CategoryTreeNode> {
  const db = getDb();

  // 检查分类是否存在
  const existing = await db
    .select()
    .from(categories)
    .where(eq(categories.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("分类不存在");
  }

  const current = existing[0];
  const updates: Record<string, unknown> = {};
  let newLevel = current.level;

  // 检查 slug 唯一性（如果变更）
  if (input.slug !== undefined && input.slug !== current.slug) {
    const slugConflict = await db
      .select()
      .from(categories)
      .where(eq(categories.slug, input.slug))
      .limit(1);

    if (slugConflict.length > 0) {
      throw new ConflictError("分类标识 slug 已被其他分类使用");
    }
    updates.slug = input.slug;
  }

  // 处理 parent_id 变更
  if (input.parent_id !== undefined && input.parent_id !== current.parent_id) {
    if (input.parent_id === null) {
      // 设为顶级
      updates.parent_id = null;
      newLevel = 0;
    } else if (input.parent_id === id) {
      throw new BadRequestError("分类不能将自己设为自己的父分类");
    } else {
      // 检查新父分类是否存在
      const newParent = await db
        .select()
        .from(categories)
        .where(eq(categories.id, input.parent_id))
        .limit(1);

      if (newParent.length === 0) {
        throw new BadRequestError("父分类不存在");
      }

      // 检查循环引用：新父分类是否为当前分类的子孙
      if (await isDescendant(input.parent_id, id)) {
        throw new BadRequestError("父分类不能是当前分类的子分类");
      }

      updates.parent_id = input.parent_id;
      newLevel = newParent[0].level + 1;
    }
  }

  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (newLevel !== current.level) updates.level = newLevel;
  updates.updated_at = new Date().toISOString();

  await db
    .update(categories)
    .set(updates)
    .where(eq(categories.id, id));

  // 如果 level 变了，递归更新子分类的 level
  if (newLevel !== current.level) {
    await recalculateLevels(id, newLevel);
  }

  return getCategory(id);
}

/**
 * 递归更新子孙分类的 level。
 */
async function recalculateLevels(
  parentId: string,
  parentLevel: number,
): Promise<void> {
  const db = getDb();
  const children = await db
    .select()
    .from(categories)
    .where(eq(categories.parent_id, parentId));

  for (const child of children) {
    const newLevel = parentLevel + 1;
    await db
      .update(categories)
      .set({ level: newLevel, updated_at: new Date().toISOString() })
      .where(eq(categories.id, child.id));
    await recalculateLevels(child.id, newLevel);
  }
}

/**
 * 检查 targetId 是否是 ancestorId 的子孙分类。
 */
async function isDescendant(
  targetId: string,
  ancestorId: string,
): Promise<boolean> {
  const db = getDb();

  let currentId: string | null = targetId;
  while (currentId) {
    if (currentId === ancestorId) return true;

    const row = await db
      .select()
      .from(categories)
      .where(eq(categories.id, currentId))
      .limit(1);

    if (row.length === 0 || !row[0].parent_id) break;
    currentId = row[0].parent_id;
  }

  return false;
}

/**
 * 删除分类。
 * 仅允许删除无子分类的分类。
 *
 * @throws {NotFoundError} 分类不存在
 * @throws {BadRequestError} 分类下有子分类
 */
export async function deleteCategory(id: string): Promise<void> {
  const db = getDb();

  const existing = await db
    .select()
    .from(categories)
    .where(eq(categories.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("分类不存在");
  }

  // 检查是否有子分类
  const children = await db
    .select()
    .from(categories)
    .where(eq(categories.parent_id, id))
    .limit(1);

  if (children.length > 0) {
    throw new BadRequestError("该分类下存在子分类，请先删除或迁移子分类");
  }

  await db.delete(categories).where(eq(categories.id, id));
}
