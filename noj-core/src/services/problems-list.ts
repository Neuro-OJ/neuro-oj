/**
 * Problems 列表与查询（PR 拆分 PR-3）。
 *
 * 提供：
 * - listProblems / listAllProblems：分页 + 多维筛选
 * - getProblem / getProblemByTypeAndNumber：单条查询
 * - attachCategories：注入关联分类（被 problems-export.ts 复用）
 * - toProblemResponse：DB 行 → 响应 DTO（仅本模块使用）
 *
 * 依赖：
 * - types.ts（DTO 接口与 ProblemResponseWithCategories）
 * - 不直接依赖 crud / categories / export（避免循环）
 */
import {
  and,
  asc,
  count,
  eq,
  ilike,
  inArray,
  type SQL,
  sql,
} from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  categories,
  problems,
  problemsCategories,
  users,
} from "../db/schema.ts";
import { BadRequestError, NotFoundError } from "../lib/errors.ts";
import {
  DIFFICULTIES,
  isValidDifficulty,
  type ProblemListQuery,
  type ProblemResponseWithCategories,
  type RuntimeConfig,
} from "../types/problems.ts";
import type {
  AdminProblemListResponse,
  ProblemListResponse,
  ProblemResponse,
} from "./problems-types.ts";

/**
 * 将数据库行转换为题目响应。
 */
function toProblemResponse(
  row: typeof problems.$inferSelect,
): ProblemResponse {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    difficulty: row.difficulty,
    support_package_storage_url: row.support_package_storage_url,
    has_support_package: row.support_package_storage_url !== null,
    runtime_config: row.runtime_config as RuntimeConfig,
    number: row.number,
    owner_id: row.owner_id,
    type: row.type,
    display_id: `${row.type}${row.number}`,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 查询并注入题目的关联分类。
 *
 * 公开给 problems-export.ts 复用——导出场景同样需要按题目 id 拉分类。
 */
export async function attachCategories(
  problemIds: string[],
): Promise<Map<string, { id: string; name: string; slug: string }[]>> {
  if (problemIds.length === 0) return new Map();

  const db = getDb();
  const rows = await db
    .select({
      problem_id: problemsCategories.problem_id,
      category_id: problemsCategories.category_id,
      category_name: categories.name,
      category_slug: categories.slug,
    })
    .from(problemsCategories)
    .innerJoin(categories, eq(categories.id, problemsCategories.category_id))
    .where(inArray(problemsCategories.problem_id, problemIds));

  const map = new Map<string, { id: string; name: string; slug: string }[]>();
  for (const row of rows) {
    const list = map.get(row.problem_id) ?? [];
    list.push({
      id: row.category_id,
      name: row.category_name,
      slug: row.category_slug,
    });
    map.set(row.problem_id, list);
  }
  return map;
}

/**
 * 分页获取题目列表。
 * 支持按 difficulty、category_id、keyword 筛选。
 */
export async function listProblems(
  query: ProblemListQuery = {},
): Promise<ProblemListResponse> {
  const db = getDb();
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(100, Math.max(1, query.limit ?? 20));
  const offset = (page - 1) * limit;

  // 构建筛选条件
  const conditions: SQL[] = [];

  if (query.difficulty) {
    if (!isValidDifficulty(query.difficulty)) {
      throw new BadRequestError(
        `非法难度值：${query.difficulty}，仅允许 ${DIFFICULTIES.join("/")}`,
      );
    }
    conditions.push(eq(problems.difficulty, query.difficulty));
  }

  if (query.keyword) {
    const kw = `%${query.keyword}%`;
    conditions.push(
      sql`(${ilike(problems.title, kw)} OR ${
        ilike(problems.description, kw)
      } OR ${ilike(problems.id, kw)} OR ${
        ilike(sql`CAST(${problems.number} AS TEXT)`, kw)
      } OR ${
        ilike(sql`${problems.type} || CAST(${problems.number} AS TEXT)`, kw)
      })`,
    );
  }

  // 未指定 type 时默认只显示 P 型题目（U 型仅通过 URL 或用户主页访问）
  conditions.push(eq(problems.type, (query.type || "P").toUpperCase()));

  if (query.number !== undefined) {
    conditions.push(eq(problems.number, query.number));
  }

  if (query.owner_id) {
    conditions.push(eq(problems.owner_id, query.owner_id));
  }

  // 按分类筛选——先查关联表拿到题目 ID，再通过 inArray 下推到 SQL WHERE 层
  if (query.category_id) {
    const catRows = await db
      .select({ problem_id: problemsCategories.problem_id })
      .from(problemsCategories)
      .where(eq(problemsCategories.category_id, query.category_id));

    if (catRows.length === 0) {
      // 分类下无题目，直接返回空（无需进一步查询）
      return { items: [], total: 0, page, limit };
    }

    const problemIds = catRows.map((r) => r.problem_id);
    conditions.push(inArray(problems.id, problemIds));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // 查询列表（SQL 层完成全部过滤+分页）
  const items = await db
    .select()
    .from(problems)
    .where(whereClause)
    .orderBy(asc(problems.id))
    .limit(limit)
    .offset(offset);

  // 查询总数
  const countResult = await db
    .select({ count: count() })
    .from(problems)
    .where(whereClause);
  const total = Number(countResult[0]?.count ?? 0);

  // 注入关联分类信息
  const catMap = await attachCategories(items.map((p) => p.id));

  return {
    items: items.map((p) => ({
      ...toProblemResponse(p),
      categories: catMap.get(p.id) ?? [],
    })),
    total,
    page,
    limit,
  };
}

/**
 * 管理员获取全量题目列表（含 U 型和 P 型）。
 *
 * 与 listProblems 的区别：
 * - 不默认添加 type='P' 筛选条件，返回所有类型题目
 * - 额外返回 owner_username（JOIN users 表）
 * - 不返回 description 字段（列表场景不需要）
 *
 * 支持与普通列表相同的 difficulty、category_id、keyword 筛选参数。
 */
export async function listAllProblems(
  query: {
    page?: number;
    limit?: number;
    difficulty?: string;
    category_id?: string;
    keyword?: string;
  } = {},
): Promise<AdminProblemListResponse> {
  const db = getDb();
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(100, Math.max(1, query.limit ?? 20));
  const offset = (page - 1) * limit;

  // 构建筛选条件（不默认添加 type='P'）
  const conditions: SQL[] = [];

  if (query.difficulty) {
    if (!isValidDifficulty(query.difficulty)) {
      throw new BadRequestError(
        `非法难度值：${query.difficulty}，仅允许 ${DIFFICULTIES.join("/")}`,
      );
    }
    conditions.push(eq(problems.difficulty, query.difficulty));
  }

  if (query.keyword) {
    const kw = `%${query.keyword}%`;
    conditions.push(
      sql`(${ilike(problems.title, kw)} OR ${ilike(problems.description, kw)})`,
    );
  }

  // 按分类筛选
  if (query.category_id) {
    const catRows = await db
      .select({ problem_id: problemsCategories.problem_id })
      .from(problemsCategories)
      .where(eq(problemsCategories.category_id, query.category_id));

    if (catRows.length === 0) {
      return { items: [], total: 0, page, limit };
    }

    conditions.push(inArray(problems.id, catRows.map((r) => r.problem_id)));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // 查询列表：JOIN users 获取 owner_username
  const rows = await db
    .select({
      id: problems.id,
      title: problems.title,
      difficulty: problems.difficulty,
      support_package_storage_url: problems.support_package_storage_url,
      runtime_config: problems.runtime_config,
      created_at: problems.created_at,
      updated_at: problems.updated_at,
      number: problems.number,
      owner_id: problems.owner_id,
      owner_username: users.username,
      type: problems.type,
    })
    .from(problems)
    .leftJoin(users, eq(problems.owner_id, users.id))
    .where(whereClause)
    .orderBy(asc(problems.id))
    .limit(limit)
    .offset(offset);

  // 查询总数
  const countResult = await db
    .select({ count: count() })
    .from(problems)
    .where(whereClause);
  const total = Number(countResult[0]?.count ?? 0);

  // 注入关联分类信息
  const catMap = await attachCategories(rows.map((r) => r.id));

  return {
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      difficulty: r.difficulty,
      support_package_storage_url: r.support_package_storage_url,
      runtime_config: r.runtime_config as RuntimeConfig,
      categories: catMap.get(r.id) ?? [],
      created_at: r.created_at,
      updated_at: r.updated_at,
      number: r.number,
      owner_id: r.owner_id,
      owner_username: r.owner_username ?? "未知",
      type: r.type,
      display_id: `${r.type}${r.number}`,
    })),
    total,
    page,
    limit,
  };
}

/**
 * 根据 ID 获取题目详情（含分类信息）。
 *
 * @throws {NotFoundError} 题目不存在
 */
export async function getProblem(
  id: string,
): Promise<ProblemResponseWithCategories> {
  const db = getDb();

  const existing = await db
    .select()
    .from(problems)
    .where(eq(problems.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("题目不存在");
  }

  const catMap = await attachCategories([id]);
  return {
    ...toProblemResponse(existing[0]),
    categories: catMap.get(id) ?? [],
  };
}

/**
 * 根据 type+number 组合唯一索引查找题目。
 * 用于双索引路由解析 display_id（如 P1001 → type=P, number=1001）。
 *
 * @throws {NotFoundError} 题目不存在
 */
export async function getProblemByTypeAndNumber(
  type: string,
  number: number,
): Promise<ProblemResponseWithCategories> {
  const db = getDb();

  const existing = await db
    .select()
    .from(problems)
    .where(
      and(
        eq(problems.type, type.toUpperCase()),
        eq(problems.number, number),
      ),
    )
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("题目不存在");
  }

  const catMap = await attachCategories([existing[0].id]);
  return {
    ...toProblemResponse(existing[0]),
    categories: catMap.get(existing[0].id) ?? [],
  };
}
