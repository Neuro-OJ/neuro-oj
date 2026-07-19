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
  evaluationResults,
  problems,
  problemsCategories,
  submissions,
  users,
} from "../db/schema.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../lib/errors.ts";
import {
  type CreateProblemInput,
  DIFFICULTIES,
  EXPORT_VERSION,
  type ExportPayload,
  type ExportProblem,
  type ExportQuery,
  type ImportItemResult,
  type ImportReport,
  type ImportStrategy,
  isValidDifficulty,
  isValidProblemType,
  type ProblemListQuery,
  type ProblemResponseWithCategories,
  type RuntimeConfig,
  type UpdateProblemInput,
} from "../types/problems.ts";
import { validateJudgeImageWithKind } from "./judge-images.ts";
import { getStorageProvider } from "../lib/storage/mod.ts";
import { extractSamples } from "../lib/samples.ts";
import { listCategories } from "./categories.ts";
import { logAudit } from "./audit-log.ts";
import { logger } from "../lib/logging.ts";

export interface ProblemResponse {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  support_package_storage_url: string | null;
  has_support_package: boolean;
  runtime_config: RuntimeConfig;
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
 * 管理员专属题目列表项（不含 description，额外包含 owner_username）。
 */
export interface AdminProblemListItem {
  id: string;
  title: string;
  difficulty: string;
  support_package_storage_url: string | null;
  runtime_config: RuntimeConfig;
  categories: { id: string; name: string; slug: string }[];
  created_at: string;
  updated_at: string;
  number: number;
  owner_id: string;
  owner_username: string;
  type: string;
  display_id: string;
}

export interface AdminProblemListResponse {
  items: AdminProblemListItem[];
  total: number;
  page: number;
  limit: number;
}

/**
 * 将数据库行转换为题目响应。
 */
/**
 * 校验 runtime_config 结构（不涉及白名单 / kind，调用方负责）。
 *
 * @throws {BadRequestError} 缺字段、类型错、值越界
 */
export function validateRuntimeConfig(rc: RuntimeConfig): void {
  if (!rc.evaluator || typeof rc.evaluator !== "object") {
    throw new BadRequestError("runtime_config.evaluator 必须是对象");
  }
  if (!rc.solution || typeof rc.solution !== "object") {
    throw new BadRequestError("runtime_config.solution 必须是对象");
  }

  const e = rc.evaluator;
  if (typeof e.image !== "string" || !e.image.trim()) {
    throw new BadRequestError(
      "runtime_config.evaluator.image 必须是非空字符串",
    );
  }
  if (typeof e.command !== "string" || !e.command.trim()) {
    throw new BadRequestError(
      "runtime_config.evaluator.command 必须是非空字符串",
    );
  }
  if (typeof e.time_limit_ms !== "number" || e.time_limit_ms <= 0) {
    throw new BadRequestError(
      "runtime_config.evaluator.time_limit_ms 必须为正整数",
    );
  }
  if (typeof e.memory_limit_mb !== "number" || e.memory_limit_mb <= 0) {
    throw new BadRequestError(
      "runtime_config.evaluator.memory_limit_mb 必须为正整数",
    );
  }

  const s = rc.solution;
  if (typeof s.image !== "string" || !s.image.trim()) {
    throw new BadRequestError("runtime_config.solution.image 必须是非空字符串");
  }
  if (typeof s.entry !== "string" || !s.entry.trim()) {
    throw new BadRequestError("runtime_config.solution.entry 必须是非空字符串");
  }
  // entry 安全校验：禁止路径分隔符与 ..
  if (
    s.entry.includes("/") || s.entry.includes("\\") || s.entry.includes("..")
  ) {
    throw new BadRequestError(
      `runtime_config.solution.entry 含非法字符：${s.entry}`,
    );
  }
  if (typeof s.call_timeout_ms !== "number" || s.call_timeout_ms <= 0) {
    throw new BadRequestError(
      "runtime_config.solution.call_timeout_ms 必须为正整数",
    );
  }
  if (typeof s.memory_limit_mb !== "number" || s.memory_limit_mb <= 0) {
    throw new BadRequestError(
      "runtime_config.solution.memory_limit_mb 必须为正整数",
    );
  }
}

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

  // 校验 runtime_config（所有题目统一使用双容器模式）
  if (input.runtime_config !== undefined && input.runtime_config !== null) {
    validateRuntimeConfig(input.runtime_config);
    try {
      await validateJudgeImageWithKind(
        input.runtime_config.evaluator.image,
        "evaluator",
      );
      await validateJudgeImageWithKind(
        input.runtime_config.solution.image,
        "solution",
      );
    } catch (err) {
      logger.error("createProblem: runtime_config 镜像校验失败", { err });
      throw err;
    }
  } else {
    logger.error("createProblem: runtime_config 缺失", {
      input: JSON.stringify(input),
    });
    throw new BadRequestError("runtime_config 是必填字段");
  }

  // 题目主键统一由服务端生成 UUID，避免客户端注入字符串 id
  // 影响 display_id 双索引路由解析
  const id = crypto.randomUUID();

  // 确定题目类型（默认 U）
  const rawType = input.type?.toUpperCase() ?? "U";
  if (!isValidProblemType(rawType)) {
    throw new BadRequestError(`非法题目类型：${input.type}，仅允许 U/P`);
  }
  const type = rawType;

  // 权限检查：普通用户只能创建 U 型
  if (type === "P" && userRole !== "admin") {
    throw new ForbiddenError("仅管理员可创建管理题");
  }

  // 确定所有者
  const ownerId = userId ?? "0";

  // 确定题号（同一 type 内自增，并发冲突时重试）
  // 仅 admin 可指定 number；普通用户强制 MAX+1
  const adminProvidedNumber = input.number !== undefined;
  if (adminProvidedNumber && userRole !== "admin") {
    throw new ForbiddenError("仅管理员可指定题号");
  }
  let number = input.number;
  // 确定题号 + 插入（MAX+1 并发冲突时最多重试 3 次）
  const MAX_RETRIES = 3;
  const now = new Date().toISOString();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (number === undefined) {
      const result = await db
        .select({ max: sql<number>`COALESCE(MAX(${problems.number}), 0)` })
        .from(problems)
        .where(eq(problems.type, type));
      number = (result[0]?.max ?? 0) + 1;
    }

    try {
      await db.insert(problems).values({
        id,
        title: input.title,
        description: input.description,
        difficulty: input.difficulty ?? "medium",
        support_package_storage_url: input.support_package_storage_url ?? null,
        runtime_config: input.runtime_config ?? null,
        number,
        owner_id: ownerId,
        type,
        created_at: now,
        updated_at: now,
      });
      break; // 插入成功，退出重试循环
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      // PostgreSQL UNIQUE 约束冲突错误码 23505
      // postgres.js 在 err.code，PGlite 在 err.cause.code
      const pgCode = err && typeof err === "object"
        ? (err as Record<string, unknown>).code ||
          ((err as Record<string, unknown>).cause as Record<string, unknown>)
            ?.code
        : undefined;
      if (pgCode === "23505") {
        // 管理员指定 number 冲突 → 直接报错，不自动重试
        if (adminProvidedNumber) throw err;
        number = undefined; // 重置 number，下一轮重新 MAX+1
        continue;
      }
      throw err; // 非唯一冲突，直接抛出
    }
  }

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

  // 校验 runtime_config
  //   undefined → 不变；null → 拒绝（runtime_config 是必填字段）；object → 校验并写入
  if (input.runtime_config !== undefined) {
    if (input.runtime_config === null) {
      throw new BadRequestError("runtime_config 是必填字段，不可清空");
    }
    validateRuntimeConfig(input.runtime_config);
    await validateJudgeImageWithKind(
      input.runtime_config.evaluator.image,
      "evaluator",
    );
    await validateJudgeImageWithKind(
      input.runtime_config.solution.image,
      "solution",
    );
  }

  // 防御性忽略 type 和 number（spec 承诺这两个字段不可变更）
  delete (input as Record<string, unknown>)["type"];
  delete (input as Record<string, unknown>)["number"];

  const updates: Record<string, unknown> = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.description !== undefined) updates.description = input.description;
  if (input.difficulty !== undefined) updates.difficulty = input.difficulty;
  if (input.support_package_storage_url !== undefined) {
    updates.support_package_storage_url = input.support_package_storage_url;
  }
  if (input.runtime_config !== undefined) {
    updates.runtime_config = input.runtime_config;
  }
  updates.updated_at = new Date().toISOString();

  await db.update(problems).set(updates).where(eq(problems.id, id));

  // 处理分类关联
  if (input.category_ids !== undefined) {
    await syncProblemCategories(id, input.category_ids);
  }

  // 审计日志：runtime_config 变更
  if (input.runtime_config !== undefined) {
    const oldHas = problem.runtime_config !== null;
    const newHas = input.runtime_config !== null;
    if (
      oldHas !== newHas ||
      JSON.stringify(problem.runtime_config) !==
        JSON.stringify(input.runtime_config)
    ) {
      await logAudit(
        "problems.runtime_config_changed",
        {
          action: "problems.runtime_config_changed",
          title: problem.title,
          display_id: `${problem.type}${problem.number}`,
          old_has_runtime_config: oldHas,
          new_has_runtime_config: newHas,
        },
        { type: "problem", id },
      );
    }
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

  // 清理支持包（通过 StorageProvider，幂等）
  const storageUrl = problem.support_package_storage_url;
  if (storageUrl) {
    try {
      const storage = await getStorageProvider();
      await storage.delete(storageUrl);
    } catch (err) {
      logger.error("清理支持包失败", { storage_url: storageUrl, err });
    }
  }

  // 清理关联提交（submissions 无 ON DELETE CASCADE，需手动清理）
  await db.delete(evaluationResults)
    .where(
      inArray(
        evaluationResults.submission_id,
        db.select({ id: submissions.id })
          .from(submissions)
          .where(eq(submissions.problem_id, id)),
      ),
    );
  await db.delete(submissions).where(eq(submissions.problem_id, id));

  // 级联删除（problems_categories 的 ON DELETE CASCADE 会自动清理关联）
  await db.delete(problems).where(eq(problems.id, id));

  // 审计日志：删除成功后才记录（display_id 由 type+number 派生）
  await logAudit(
    "problems.delete",
    {
      action: "problems.delete",
      title: problem.title,
      display_id: `${problem.type}${problem.number}`,
    },
    { type: "problem", id },
  );
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

// ─── 题目导入导出（issue #28）─────────────────────────────────

/**
 * 校验 support_package_storage_url 格式合法。
 *
 * 走法 A 不做可达性检查——导出是元数据操作，不应因为临时 S3 故障
 * 就让导出失败。如果 URL 真正坏掉，导入后 judge 端评测会自然报错。
 * 这里只拦截明显错误的协议前缀，避免 round-trip 引入脏数据。
 */
function assertStorageUrlFormat(url: string | null): void {
  if (!url) return;
  if (
    !url.startsWith("noj-storage://") &&
    !url.startsWith("noj-download://")
  ) {
    throw new BadRequestError(
      `支持包 URL 协议不受支持：${url}（仅支持 noj-storage:// 或 noj-download://）`,
    );
  }
}

/**
 * 导出题目集合为标准 JSON 结构。
 *
 * 查询模式：
 * - `ids` 优先：按指定 id 列表精确导出
 * - `type`：按题目类型批量导出（U/P 全部）
 * - 二者都未提供或都提供 → 拒绝
 *
 * 返回结构遵循 EXPORT_VERSION 约定的字段命名，round-trip 安全。
 *
 * @throws {BadRequestError} 查询参数非法 / 支持包 URL 校验失败
 */
export async function buildExportPayload(
  query: ExportQuery,
  exportedBy: string,
): Promise<ExportPayload> {
  const db = getDb();

  // 互斥校验
  const hasIds = query.ids !== undefined && query.ids.length > 0;
  const hasType = query.type !== undefined;
  if (hasIds && hasType) {
    throw new BadRequestError("ids 和 type 互斥，请二选一");
  }
  if (!hasIds && !hasType) {
    throw new BadRequestError("必须提供 ids 或 type 之一");
  }
  if (hasType && query.type !== undefined && !isValidProblemType(query.type)) {
    throw new BadRequestError(
      `非法题目类型：${query.type}，仅允许 U/P`,
    );
  }

  // 查询题目
  let rows: (typeof problems.$inferSelect)[];
  if (hasIds) {
    rows = await db
      .select()
      .from(problems)
      .where(inArray(problems.id, query.ids!));
  } else {
    rows = await db
      .select()
      .from(problems)
      .where(eq(problems.type, query.type!));
  }

  if (rows.length === 0) {
    return {
      version: EXPORT_VERSION,
      exported_at: new Date().toISOString(),
      exported_by: exportedBy,
      problems: [],
    };
  }

  // 注入分类信息
  const catMap = await attachCategories(rows.map((r) => r.id));

  // 校验所有 support_package URL 协议前缀合法
  for (const row of rows) {
    assertStorageUrlFormat(row.support_package_storage_url);
  }

  // 组装 ExportProblem
  const exportedProblems: ExportProblem[] = rows.map((row) => {
    const cats = catMap.get(row.id) ?? [];
    return {
      id: row.id,
      display_id: `${row.type}${row.number}`,
      type: row.type as "U" | "P",
      number: row.number,
      title: row.title,
      description: row.description,
      difficulty: row.difficulty,
      categories: cats.map((c) => ({ name: c.name, slug: c.slug })),
      support_package_storage_url: row.support_package_storage_url,
      test_cases_ref: row.support_package_storage_url,
      runtime_config: row.runtime_config as RuntimeConfig,
      samples: extractSamples(row.description),
    };
  });

  return {
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    exported_by: exportedBy,
    problems: exportedProblems,
  };
}

// ─── 导入服务 ──────────────────────────────────────────────

/**
 * 导入 payload 类型守卫。
 * 校验 version、problems 数组、每个 ExportProblem 的基本字段。
 */
function parseImportPayload(input: unknown): ExportPayload {
  if (!input || typeof input !== "object") {
    throw new BadRequestError("导入文件必须为 JSON 对象");
  }
  const obj = input as Record<string, unknown>;
  if (obj.version !== EXPORT_VERSION) {
    throw new BadRequestError(
      `不支持的导入文件版本：${
        String(obj.version)
      }（当前仅支持 ${EXPORT_VERSION}）`,
    );
  }
  if (!Array.isArray(obj.problems)) {
    throw new BadRequestError("导入文件必须包含 problems 数组");
  }
  for (let i = 0; i < obj.problems.length; i++) {
    const p = obj.problems[i] as Record<string, unknown> | null;
    if (!p || typeof p !== "object") {
      throw new BadRequestError(`problems[${i}] 不是合法对象`);
    }
    for (
      const field of [
        "id",
        "title",
        "description",
        "type",
        "number",
      ]
    ) {
      if (!(field in p)) {
        throw new BadRequestError(
          `problems[${i}] 缺少必填字段：${field}`,
        );
      }
    }
  }
  return obj as unknown as ExportPayload;
}

/**
 * 构建分类 name → id 映射（用于按 name 解析导入题目中的分类关联）。
 *
 * 走法 A 不支持自动创建分类——不存在的分类名会被忽略（warning），
 * 由 admin 自行在导入前手动创建，避免脏数据。
 */
async function buildCategoryLookup(): Promise<Map<string, string>> {
  const tree = await listCategories();
  const map = new Map<string, string>();
  const visit = (nodes: typeof tree) => {
    for (const n of nodes) {
      map.set(n.name, n.id);
      if (n.children.length > 0) visit(n.children);
    }
  };
  visit(tree);
  return map;
}

/**
 * 把单个 ExportProblem 落到数据库。
 *
 * 策略行为：
 * - create: 已存在 → skip；不存在 → 新建
 * - overwrite: 已存在 → 更新（type/number 不可变）；不存在 → 新建
 * - skip: 已存在 → skip；不存在 → 新建
 *
 * 权限：
 * - 仅 admin 可调用
 * - 若 import 项的 type='P'，会校验 userRole
 *
 * @returns 该条目的处理结果（含写入后的 problem_id）
 */
async function importOne(
  item: ExportProblem,
  strategy: ImportStrategy,
  userId: string,
  userRole: string,
  categoryLookup: Map<string, string>,
): Promise<ImportItemResult> {
  const baseResult: Omit<ImportItemResult, "action" | "problem_id"> = {
    id: item.id,
    display_id: item.display_id,
  };

  // 1. 难度值校验
  if (!isValidDifficulty(item.difficulty)) {
    return {
      ...baseResult,
      action: "failed",
      reason: `非法难度值：${item.difficulty}`,
    };
  }

  // 2. 题目类型校验
  if (!isValidProblemType(item.type)) {
    return {
      ...baseResult,
      action: "failed",
      reason: `非法题目类型：${item.type}`,
    };
  }

  // 3. P 型题需要 admin
  if (item.type === "P" && userRole !== "admin") {
    return {
      ...baseResult,
      action: "failed",
      reason: "P 型题仅管理员可导入",
    };
  }

  // 4. support_package_storage_url 协议前缀校验
  if (item.support_package_storage_url) {
    if (
      !item.support_package_storage_url.startsWith("noj-storage://") &&
      !item.support_package_storage_url.startsWith("noj-download://")
    ) {
      return {
        ...baseResult,
        action: "failed",
        reason: `支持包 URL 协议不受支持：${item.support_package_storage_url}`,
      };
    }
  }

  // 6. 分类解析（按 name 查；找不到的跳过）
  const categoryIds: string[] = [];
  const missingCategories: string[] = [];
  for (const c of item.categories) {
    const id = categoryLookup.get(c.name);
    if (id) {
      categoryIds.push(id);
    } else {
      missingCategories.push(c.name);
    }
  }

  // 7. 检查目标问题是否存在（按 source id）
  const db = getDb();
  const existing = await db
    .select()
    .from(problems)
    .where(eq(problems.id, item.id))
    .limit(1);

  if (existing.length > 0) {
    // 目标已存在
    if (strategy === "create" || strategy === "skip") {
      return {
        ...baseResult,
        action: "skipped",
        reason: strategy === "create"
          ? "目标 id 已存在，create 策略跳过"
          : "目标 id 已存在，skip 策略跳过",
        problem_id: existing[0].id,
      };
    }
    // overwrite：更新元数据
    const updates: Record<string, unknown> = {
      title: item.title,
      description: item.description,
      difficulty: item.difficulty,
      support_package_storage_url: item.support_package_storage_url,
      runtime_config:
        (item.runtime_config as RuntimeConfig | null | undefined) ?? {
          evaluator: {
            image: "noj-evaluator-python",
            command: "python3 /workspace/evaluate.py",
            time_limit_ms: 5000,
            memory_limit_mb: 512,
          },
          solution: {
            image: "noj-solution-python",
            entry: "submission_sample.py",
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        },
      updated_at: new Date().toISOString(),
    };
    await db.update(problems).set(updates).where(eq(problems.id, item.id));
    await syncProblemCategories(item.id, categoryIds);
    return {
      ...baseResult,
      action: "updated",
      problem_id: item.id,
    };
  }

  // 8. 目标不存在 → 新建
  try {
    const created = await createProblem(
      {
        title: item.title,
        description: item.description,
        difficulty: item.difficulty,
        support_package_storage_url: item.support_package_storage_url,
        runtime_config:
          (item.runtime_config as RuntimeConfig | null | undefined) ?? {
            evaluator: {
              image: "noj-evaluator-python",
              command: "python3 /workspace/evaluate.py",
              time_limit_ms: 5000,
              memory_limit_mb: 512,
            },
            solution: {
              image: "noj-solution-python",
              entry: "submission_sample.py",
              call_timeout_ms: 2000,
              memory_limit_mb: 512,
            },
          },
        type: item.type,
        number: item.number,
        category_ids: categoryIds,
      },
      userId,
      userRole,
    );
    const reasonSuffix = missingCategories.length > 0
      ? `（注意：以下分类在当前 DB 不存在，已忽略：${
        missingCategories.join("、")
      }）`
      : undefined;
    return {
      ...baseResult,
      action: "created",
      problem_id: created.id,
      reason: reasonSuffix,
    };
  } catch (err) {
    return {
      ...baseResult,
      action: "failed",
      reason: `创建失败：${err instanceof Error ? err.message : String(err)}${
        missingCategories.length > 0
          ? `；缺失分类：${missingCategories.join("、")}`
          : ""
      }`,
    };
  }
}

/**
 * 批量导入题目。
 *
 * @param input 原始 JSON（来自请求体或文件）
 * @param strategy 三种策略之一
 * @param userId 当前 admin id
 * @param userRole 当前 admin role
 * @returns 导入结果报告（按 action 分桶）
 */
export async function importProblems(
  input: unknown,
  strategy: ImportStrategy,
  userId: string,
  userRole: string,
): Promise<ImportReport> {
  if (
    strategy !== "create" && strategy !== "overwrite" && strategy !== "skip"
  ) {
    throw new BadRequestError(
      `非法导入策略：${strategy}（仅支持 create/overwrite/skip）`,
    );
  }

  const payload = parseImportPayload(input);

  // 预构建分类查找表（一次查询，避免 N+1）
  const categoryLookup = await buildCategoryLookup();

  const created: ImportItemResult[] = [];
  const updated: ImportItemResult[] = [];
  const skipped: ImportItemResult[] = [];
  const failed: ImportItemResult[] = [];

  for (const item of payload.problems) {
    const result = await importOne(
      item,
      strategy,
      userId,
      userRole,
      categoryLookup,
    );
    switch (result.action) {
      case "created":
        created.push(result);
        break;
      case "updated":
        updated.push(result);
        break;
      case "skipped":
        skipped.push(result);
        break;
      case "failed":
        failed.push(result);
        break;
    }
  }

  return {
    strategy,
    total: payload.problems.length,
    created,
    updated,
    skipped,
    failed,
  };
}
