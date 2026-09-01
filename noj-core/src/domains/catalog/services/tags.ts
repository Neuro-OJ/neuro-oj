/**
 * 标签服务（issue #223：category 系统退役，双类标签取代）。
 *
 * 提供：
 * - listTags：全量标签列表（含关联题目数，按 name 升序），公开
 * - createTag / updateTag / deleteTag：写操作（路由层以 tag:manage 权限保护）
 * - mergeTags：标签合并（关联重指向 → 删除源标签，单事务）
 * - getTagIdsByNames：按名称批量解析标签（供题目导入复用）
 *
 * 设计要点：
 * - name 全局唯一（跨 kind），冲突抛 ConflictError
 * - kind ∈ ('problem', 'algorithm')：problem=题目标签（人人可见）
 *   algorithm=算法标签（通过题目后可见，spoiler 门控见 problems-list.ts）
 * - 全部写操作写入审计（tags.create/update/delete/merge）
 */
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../db/connection.ts";
import { problemTags, tags } from "../../../db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../lib/errors.ts";
import { logAudit } from "../../system/index.ts";

/** 标签 kind 枚举。 */
export const TAG_KINDS = ["problem", "algorithm"] as const;

/** 标签 kind 类型：problem=题目标签，algorithm=算法标签。 */
export type TagKind = typeof TAG_KINDS[number];

/** 标签响应 DTO。 */
export interface TagResponse {
  id: string;
  name: string;
  kind: TagKind;
  /** 关联题目数（管理页表格展示）。 */
  problem_count: number;
  created_at: string;
  updated_at: string;
}

/** 创建标签的输入。 */
export interface CreateTagInput {
  name: string;
  kind: string;
}

/** 更新标签的输入（字段可选，仅更新提供的字段）。 */
export interface UpdateTagInput {
  name?: string;
  kind?: string;
}

/** 校验 kind 值合法。 */
export function isValidTagKind(value: string): value is TagKind {
  return TAG_KINDS.includes(value as TagKind);
}

/**
 * 判断数据库错误是否为唯一约束冲突（PG 23505；PGlite 在 cause.code）。
 * 与 problems-crud.ts 的 MAX_RETRIES 处理同款解析。
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as Record<string, unknown>;
  const pgCode = rec.code ??
    ((rec.cause as Record<string, unknown> | undefined)?.code);
  return pgCode === "23505";
}

/**
 * 获取全部标签（含关联题目数，按 name 升序）。
 */
export async function listTags(): Promise<TagResponse[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: tags.id,
      name: tags.name,
      kind: tags.kind,
      created_at: tags.created_at,
      updated_at: tags.updated_at,
      problemCount: count(problemTags.tag_id),
    })
    .from(tags)
    .leftJoin(problemTags, eq(problemTags.tag_id, tags.id))
    .groupBy(tags.id)
    .orderBy(asc(tags.name));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind as TagKind,
    problem_count: Number(row.problemCount ?? 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

/**
 * 获取单个标签（含关联题目数）。
 *
 * @throws {NotFoundError} 标签不存在
 */
export async function getTag(id: string): Promise<TagResponse> {
  const db = getDb();
  const rows = await db
    .select({
      id: tags.id,
      name: tags.name,
      kind: tags.kind,
      created_at: tags.created_at,
      updated_at: tags.updated_at,
      problemCount: count(problemTags.tag_id),
    })
    .from(tags)
    .leftJoin(problemTags, eq(problemTags.tag_id, tags.id))
    .where(eq(tags.id, id))
    .groupBy(tags.id)
    .limit(1);

  if (rows.length === 0) {
    throw new NotFoundError("标签不存在");
  }

  const row = rows[0];
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as TagKind,
    problem_count: Number(row.problemCount ?? 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 创建标签。
 *
 * @throws {BadRequestError} name 为空 或 kind 非法
 * @throws {ConflictError} name 已存在（全局唯一）
 */
export async function createTag(input: CreateTagInput): Promise<TagResponse> {
  const name = (input.name ?? "").trim();
  if (!name) {
    throw new BadRequestError("缺少必填字段：name");
  }
  if (!isValidTagKind(input.kind)) {
    throw new BadRequestError(
      `非法 kind：${input.kind}，仅允许 ${TAG_KINDS.join("/")}`,
    );
  }

  const db = getDb();
  const existing = await db
    .select()
    .from(tags)
    .where(eq(tags.name, name))
    .limit(1);
  if (existing.length > 0) {
    throw new ConflictError("标签名已存在");
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await db.insert(tags).values({
      id,
      name,
      kind: input.kind,
      created_at: now,
      updated_at: now,
    });
  } catch (err) {
    // 并发同名创建：SELECT 预检可能被并发写入越过，由 name UNIQUE 兜底
    // （PG 23505），转译为与预检一致的 409。
    if (isUniqueViolation(err)) {
      throw new ConflictError("标签名已存在");
    }
    throw err;
  }

  await logAudit(
    "tags.create",
    { action: "tags.create", name, kind: input.kind },
    { type: "tag", id },
  );

  return {
    id,
    name,
    kind: input.kind as TagKind,
    problem_count: 0,
    created_at: now,
    updated_at: now,
  };
}

/**
 * 更新标签（改名 / 改 kind）。
 *
 * @throws {NotFoundError} 标签不存在
 * @throws {ConflictError} 新 name 已被其他标签使用
 * @throws {BadRequestError} kind 非法 或 name 为空
 */
export async function updateTag(
  id: string,
  input: UpdateTagInput,
): Promise<TagResponse> {
  const db = getDb();
  const existing = await db
    .select()
    .from(tags)
    .where(eq(tags.id, id))
    .limit(1);
  if (existing.length === 0) {
    throw new NotFoundError("标签不存在");
  }
  const current = existing[0];

  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) {
      throw new BadRequestError("name 不能为空");
    }
    if (name !== current.name) {
      const conflict = await db
        .select()
        .from(tags)
        .where(eq(tags.name, name))
        .limit(1);
      if (conflict.length > 0 && conflict[0].id !== id) {
        throw new ConflictError("标签名已存在");
      }
      updates.name = name;
    }
  }
  if (input.kind !== undefined && input.kind !== current.kind) {
    if (!isValidTagKind(input.kind)) {
      throw new BadRequestError(
        `非法 kind：${input.kind}，仅允许 ${TAG_KINDS.join("/")}`,
      );
    }
    updates.kind = input.kind;
  }

  // 无实际变更（空 body 或 name/kind 均与现值相同）：不写库、不审计
  if (updates.name === undefined && updates.kind === undefined) {
    return getTag(id);
  }

  updates.updated_at = new Date().toISOString();

  try {
    await db.update(tags).set(updates).where(eq(tags.id, id));
  } catch (err) {
    // 并发改名：预检被越过时由 name UNIQUE 兜底（PG 23505）→ 409
    if (isUniqueViolation(err)) {
      throw new ConflictError("标签名已存在");
    }
    throw err;
  }

  const nextName = (updates.name as string | undefined) ?? current.name;
  const nextKind = (updates.kind as string | undefined) ?? current.kind;
  await logAudit(
    "tags.update",
    {
      action: "tags.update",
      from: `${current.name} (${current.kind})`,
      to: `${nextName} (${nextKind})`,
    },
    { type: "tag", id },
  );

  return getTag(id);
}

/**
 * 删除标签。
 * DB 级联清理 problem_tags 关联，题目本身不受影响。
 *
 * @throws {NotFoundError} 标签不存在
 */
export async function deleteTag(id: string): Promise<void> {
  const db = getDb();
  const existing = await db
    .select()
    .from(tags)
    .where(eq(tags.id, id))
    .limit(1);
  if (existing.length === 0) {
    throw new NotFoundError("标签不存在");
  }

  await db.delete(tags).where(eq(tags.id, id));

  await logAudit(
    "tags.delete",
    {
      action: "tags.delete",
      name: existing[0].name,
      kind: existing[0].kind,
    },
    { type: "tag", id },
  );
}

/**
 * 合并标签：source 的全部关联重指向 target → 删除 source。
 * 冲突关联（题目同时关联两标签）先行删除，保证复合主键不冲突。
 * 单事务保证原子性；合并结果保留 target 的 name 与 kind。
 *
 * @throws {BadRequestError} source == target
 * @throws {NotFoundError} source 或 target 不存在
 */
export async function mergeTags(
  sourceId: string,
  targetId: string,
): Promise<void> {
  if (sourceId === targetId) {
    throw new BadRequestError("不能将标签合并到自身");
  }

  const db = getDb();
  const source = await db
    .select()
    .from(tags)
    .where(eq(tags.id, sourceId))
    .limit(1);
  if (source.length === 0) {
    throw new NotFoundError("源标签不存在");
  }
  const target = await db
    .select()
    .from(tags)
    .where(eq(tags.id, targetId))
    .limit(1);
  if (target.length === 0) {
    throw new NotFoundError("目标标签不存在");
  }

  await db.transaction(async (tx) => {
    // 1. 删除与 target 冲突的关联（题目同时关联 source 与 target 时保留 target 一行）
    await tx.delete(problemTags).where(
      and(
        eq(problemTags.tag_id, sourceId),
        inArray(
          problemTags.problem_id,
          tx.select({ problem_id: problemTags.problem_id })
            .from(problemTags)
            .where(eq(problemTags.tag_id, targetId)),
        ),
      ),
    );
    // 2. 剩余关联重指向 target
    await tx.update(problemTags)
      .set({ tag_id: targetId })
      .where(eq(problemTags.tag_id, sourceId));
    // 3. 删除 source
    await tx.delete(tags).where(eq(tags.id, sourceId));
  });

  await logAudit(
    "tags.merge",
    {
      action: "tags.merge",
      source_name: source[0].name,
      target_name: target[0].name,
    },
    { type: "tag", id: sourceId },
  );
}

/**
 * 按名称批量解析标签 ID（供题目导入 manifest.tags 复用）。
 * 不存在的名称忽略（调用方负责 warning）。
 */
export async function getTagIdsByNames(names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(inArray(tags.name, names));
  return rows.map((r) => r.id);
}
