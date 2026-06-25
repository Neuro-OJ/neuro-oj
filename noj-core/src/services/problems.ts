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
import { categories, problems, problemsCategories } from "../db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../lib/errors.ts";
import {
  type CreateProblemInput,
  DIFFICULTIES,
  isValidDifficulty,
  type ProblemListQuery,
  type ProblemResponseWithCategories,
  type UpdateProblemInput,
} from "../types/problems.ts";

export interface ProblemResponse {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  judge_image: string;
  judge_command: string;
  support_package_path: string | null;
  time_limit_ms: number;
  memory_limit_mb: number;
  number: number;
  owner_id: string;
  type: string;
  display_id: string;
  created_at: string;
  updated_at: string;
}

export interface ProblemListResponse {
  items: ProblemResponseWithCategories[];
  total: number;
  page: number;
  limit: number;
}

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
    judge_image: row.judge_image,
    judge_command: row.judge_command,
    support_package_path: row.support_package_path,
    time_limit_ms: row.time_limit_ms,
    memory_limit_mb: row.memory_limit_mb,
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
 */
async function attachCategories(
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
      } OR ${ilike(problems.id, kw)})`,
    );
  }

  if (query.type) {
    conditions.push(eq(problems.type, query.type.toUpperCase()));
  }

  if (query.number !== undefined) {
    conditions.push(eq(problems.number, query.number));
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

/**
 * 创建题目。
 *
 * admin 可创建任意 type，普通用户仅限 U 型。
 * 自动设 owner_id 为当前用户，自动分配 U 型 number。
 *
 * @throws {BadRequestError} 难度值非法
 * @throws {ForbiddenError} 普通用户尝试创建 P 型题目
 */
export async function createProblem(
  input: CreateProblemInput,
  userId?: string,
  userRole?: string,
): Promise<ProblemResponseWithCategories> {
  const db = getDb();

  // 校验难度
  if (input.difficulty && !isValidDifficulty(input.difficulty)) {
    throw new BadRequestError(
      `非法难度值：${input.difficulty}，仅允许 ${DIFFICULTIES.join("/")}`,
    );
  }

  // 确定题目类型（默认 U）
  const type = input.type?.toUpperCase() === "P" ? "P" : "U";

  // 权限检查：普通用户只能创建 U 型
  if (type === "P" && userRole !== "admin") {
    throw new ForbiddenError("仅管理员可创建管理题");
  }

  // 确定所有者
  const ownerId = userId ?? "0";

  // 确定题号（同一 type 内自增）
  let number = input.number;
  if (number === undefined) {
    const result = await db
      .select({ max: sql<number>`COALESCE(MAX(${problems.number}), 0)` })
      .from(problems)
      .where(eq(problems.type, type));
    number = (result[0]?.max ?? 0) + 1;
  }

  const id = input.id ?? crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(problems).values({
    id,
    title: input.title,
    description: input.description,
    difficulty: input.difficulty ?? "medium",
    judge_image: input.judge_image,
    judge_command: input.judge_command,
    support_package_path: input.support_package_path ?? null,
    time_limit_ms: input.time_limit_ms ?? 5000,
    memory_limit_mb: input.memory_limit_mb ?? 512,
    number,
    owner_id: ownerId,
    type,
    created_at: now,
    updated_at: now,
  });

  // 处理分类关联
  if (input.category_ids && input.category_ids.length > 0) {
    await syncProblemCategories(id, input.category_ids);
  }

  return getProblem(id);
}

/**
 * 全量更新题目。
 *
 * 权限规则：
 * - admin 可更新任意题目
 * - U 型：owner 可更新
 * - P 型：仅 admin 可更新
 * - 禁止修改 type 和 number 字段
 *
 * @throws {NotFoundError} 题目不存在
 * @throws {BadRequestError} 难度值非法
 * @throws {ForbiddenError} 权限不足
 */
export async function updateProblem(
  id: string,
  input: UpdateProblemInput,
  userId?: string,
  userRole?: string,
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

  const problem = existing[0];

  // 权限检查
  if (userRole !== "admin") {
    if (problem.type === "P") {
      throw new ForbiddenError("仅管理员可编辑管理题");
    }
    // U 型：仅所有者可编辑
    if (problem.owner_id !== userId) {
      throw new ForbiddenError("无权编辑此题目");
    }
  }

  // 校验难度
  if (input.difficulty && !isValidDifficulty(input.difficulty)) {
    throw new BadRequestError(
      `非法难度值：${input.difficulty}，仅允许 ${DIFFICULTIES.join("/")}`,
    );
  }

  const updates: Record<string, unknown> = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.description !== undefined) updates.description = input.description;
  if (input.difficulty !== undefined) updates.difficulty = input.difficulty;
  if (input.judge_image !== undefined) updates.judge_image = input.judge_image;
  if (input.judge_command !== undefined) {
    updates.judge_command = input.judge_command;
  }
  if (input.support_package_path !== undefined) {
    updates.support_package_path = input.support_package_path;
  }
  if (input.time_limit_ms !== undefined) {
    updates.time_limit_ms = input.time_limit_ms;
  }
  if (input.memory_limit_mb !== undefined) {
    updates.memory_limit_mb = input.memory_limit_mb;
  }
  updates.updated_at = new Date().toISOString();

  await db.update(problems).set(updates).where(eq(problems.id, id));

  // 处理分类关联
  if (input.category_ids !== undefined) {
    await syncProblemCategories(id, input.category_ids);
  }

  return getProblem(id);
}

/**
 * 删除题目。
 *
 * 权限规则：
 * - admin 可删除任意题目
 * - U 型：owner 可删除
 * - P 型：仅 admin 可删除
 *
 * @throws {NotFoundError} 题目不存在
 * @throws {ForbiddenError} 权限不足
 */
export async function deleteProblem(
  id: string,
  userId?: string,
  userRole?: string,
): Promise<void> {
  const db = getDb();

  const existing = await db
    .select()
    .from(problems)
    .where(eq(problems.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("题目不存在");
  }

  const problem = existing[0];

  // 权限检查
  if (userRole !== "admin") {
    if (problem.type === "P") {
      throw new ForbiddenError("仅管理员可删除管理题");
    }
    if (problem.owner_id !== userId) {
      throw new ForbiddenError("无权删除此题目");
    }
  }

  // 级联删除（problems_categories 的 ON DELETE CASCADE 会自动清理关联）
  await db.delete(problems).where(eq(problems.id, id));
}

/**
 * 同步题目的分类关联（先删后插）。
 */
export async function syncProblemCategories(
  problemId: string,
  categoryIds: string[],
): Promise<void> {
  const db = getDb();

  // 验证所有分类 ID 都存在
  const existingCatRows = await db
    .select({ id: categories.id })
    .from(categories)
    .where(inArray(categories.id, categoryIds));

  if (existingCatRows.length !== categoryIds.length) {
    throw new BadRequestError("部分分类不存在");
  }

  // 先删后插
  await db
    .delete(problemsCategories)
    .where(eq(problemsCategories.problem_id, problemId));

  if (categoryIds.length > 0) {
    await db.insert(problemsCategories).values(
      categoryIds.map((categoryId) => ({
        problem_id: problemId,
        category_id: categoryId,
      })),
    );
  }
}
