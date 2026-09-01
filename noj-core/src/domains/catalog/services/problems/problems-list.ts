/**
 * Problems 列表与查询（PR 拆分 PR-3；issue #223 分类 → 双类标签）。
 *
 * 提供：
 * - listProblems / listAllProblems：分页 + 多维筛选（?tag= 替代 ?category_id=）
 * - getProblem / getProblemByTypeAndNumber：单条查询（含全部标签）
 * - attachTags：注入关联标签（可指定 kind 过滤；被题目导入/列表复用）
 * - applyAlgorithmTagVisibility：算法标签可视性门控（spoiler 模型）
 * - toProblemResponse：DB 行 → 响应 DTO（仅本模块使用）
 *
 * 依赖：
 * - types.ts（DTO 接口与 ProblemResponseWithTags）
 * - 不直接依赖 crud / tags / export（避免循环）
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
import { getDb } from "../../../../db/connection.ts";
import {
  evaluationResults,
  problems,
  problemTags,
  submissions,
  tags,
  users,
} from "../../../../db/schema.ts";
import { BadRequestError, NotFoundError } from "../../../../lib/errors.ts";
import type { TagKind } from "../tags.ts";
import {
  DIFFICULTIES,
  isValidDifficulty,
  type ProblemListQuery,
  type ProblemResponseWithTags,
  type ProblemTagRef,
  type RuntimeConfig,
} from "../../../../types/problems.ts";
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
    llm_config: row.llm_config as ProblemResponse["llm_config"],
    number: row.number,
    owner_id: row.owner_id,
    type: row.type,
    is_objective: row.is_objective,
    submission_mode: row.submission_mode as ProblemResponse["submission_mode"],
    artifact_max_size_mb: row.artifact_max_size_mb,
    display_id: `${row.type}${row.number}`,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 查询并注入题目的关联标签。
 *
 * @param problemIds 题目 ID 列表
 * @param opts.kind 仅返回指定 kind 的标签（列表场景传 "problem"，
 *                  详情/导入场景缺省返回全部）
 * 公开给题目导入等场景复用——需要按题目 id 拉标签。
 */
export async function attachTags(
  problemIds: string[],
  opts: { kind?: TagKind } = {},
): Promise<Map<string, ProblemTagRef[]>> {
  if (problemIds.length === 0) return new Map();

  const db = getDb();
  const rows = await db
    .select({
      problem_id: problemTags.problem_id,
      tag_id: problemTags.tag_id,
      tag_name: tags.name,
      tag_kind: tags.kind,
    })
    .from(problemTags)
    .innerJoin(tags, eq(tags.id, problemTags.tag_id))
    .where(
      and(
        inArray(problemTags.problem_id, problemIds),
        opts.kind ? eq(tags.kind, opts.kind) : undefined,
      ),
    );

  const map = new Map<string, ProblemTagRef[]>();
  for (const row of rows) {
    const list = map.get(row.problem_id) ?? [];
    list.push({
      id: row.tag_id,
      name: row.tag_name,
      kind: row.tag_kind,
    });
    map.set(row.problem_id, list);
  }
  return map;
}

/**
 * 分页获取题目列表。
 * 支持按 difficulty、tag、keyword 筛选；列表仅附带题目标签（kind=problem）。
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

  // 按标签筛选——先查关联表拿到题目 ID，再通过 inArray 下推到 SQL WHERE 层
  if (query.tag) {
    const tagRows = await db
      .select({ problem_id: problemTags.problem_id })
      .from(problemTags)
      .where(eq(problemTags.tag_id, query.tag));

    if (tagRows.length === 0) {
      // 标签下无题目，直接返回空（无需进一步查询）
      return { items: [], total: 0, page, limit };
    }

    const problemIds = tagRows.map((r) => r.problem_id);
    conditions.push(inArray(problems.id, problemIds));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // 查询列表（SQL 层完成全部过滤+分页；JOIN users 获取创建者用户名）
  const rows = await db
    .select({
      problem: problems,
      owner_username: users.username,
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

  // 注入关联标签（列表只返回题目标签，算法标签仅详情页出现）
  const tagMap = await attachTags(rows.map((r) => r.problem.id), {
    kind: "problem",
  });

  return {
    items: rows.map((r) => ({
      ...toProblemResponse(r.problem),
      owner_username: r.owner_username ?? "未知",
      tags: tagMap.get(r.problem.id) ?? [],
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
 * 支持与普通列表相同的 difficulty、tag、keyword 筛选参数。
 */
export async function listAllProblems(
  query: {
    page?: number;
    limit?: number;
    difficulty?: string;
    tag?: string;
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

  // 按标签筛选
  if (query.tag) {
    const tagRows = await db
      .select({ problem_id: problemTags.problem_id })
      .from(problemTags)
      .where(eq(problemTags.tag_id, query.tag));

    if (tagRows.length === 0) {
      return { items: [], total: 0, page, limit };
    }

    conditions.push(inArray(problems.id, tagRows.map((r) => r.problem_id)));
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
      llm_config: problems.llm_config,
      created_at: problems.created_at,
      updated_at: problems.updated_at,
      number: problems.number,
      owner_id: problems.owner_id,
      owner_username: users.username,
      type: problems.type,
      is_objective: problems.is_objective,
      submission_mode: problems.submission_mode,
      artifact_max_size_mb: problems.artifact_max_size_mb,
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

  // 注入关联标签（列表只返回题目标签）
  const tagMap = await attachTags(rows.map((r) => r.id), { kind: "problem" });

  return {
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      difficulty: r.difficulty,
      support_package_storage_url: r.support_package_storage_url,
      runtime_config: r.runtime_config as RuntimeConfig,
      llm_config: r.llm_config as ProblemResponse["llm_config"],
      tags: tagMap.get(r.id) ?? [],
      created_at: r.created_at,
      updated_at: r.updated_at,
      number: r.number,
      owner_id: r.owner_id,
      owner_username: r.owner_username ?? "未知",
      type: r.type,
      is_objective: r.is_objective,
      submission_mode: r.submission_mode as ProblemResponse["submission_mode"],
      artifact_max_size_mb: r.artifact_max_size_mb,
      display_id: `${r.type}${r.number}`,
    })),
    total,
    page,
    limit,
  };
}

/**
 * 根据 ID 获取题目详情（含全部标签，不做可视性裁剪）。
 *
 * 可视性门控由路由层经 applyAlgorithmTagVisibility 应用（需要 viewer 上下文）。
 *
 * @throws {NotFoundError} 题目不存在
 */
export async function getProblem(
  id: string,
): Promise<ProblemResponseWithTags> {
  const db = getDb();

  const existing = await db
    .select({
      problem: problems,
      owner_username: users.username,
    })
    .from(problems)
    .leftJoin(users, eq(problems.owner_id, users.id))
    .where(eq(problems.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("题目不存在");
  }

  const row = existing[0];
  const tagMap = await attachTags([id]);
  return {
    ...toProblemResponse(row.problem),
    owner_username: row.owner_username ?? "未知",
    tags: tagMap.get(id) ?? [],
    has_hidden_algorithm_tags: false,
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
): Promise<ProblemResponseWithTags> {
  const db = getDb();

  const existing = await db
    .select({
      problem: problems,
      owner_username: users.username,
    })
    .from(problems)
    .leftJoin(users, eq(problems.owner_id, users.id))
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

  const row = existing[0];
  const tagMap = await attachTags([row.problem.id]);
  return {
    ...toProblemResponse(row.problem),
    owner_username: row.owner_username ?? "未知",
    tags: tagMap.get(row.problem.id) ?? [],
    has_hidden_algorithm_tags: false,
  };
}

/**
 * 可视性门控的 viewer 上下文。
 */
export interface ProblemViewer {
  userId?: string;
  isAdmin?: boolean;
}

/**
 * 算法标签可视性门控（spoiler 模型，issue #223）。
 *
 * 规则：
 * - kind='problem' 标签始终返回
 * - kind='algorithm' 标签仅 admin / 题目 owner / 有通过提交（finished 且 score>0）的 viewer 可见
 * - 其余 viewer 收不到算法标签名称与数量，仅置 has_hidden_algorithm_tags=true
 * - 无算法标签 → has_hidden_algorithm_tags=false
 * 按请求时最新提交状态实时计算（无缓存；rejudge 后 AC 消失则标签随之隐藏）。
 */
export async function applyAlgorithmTagVisibility(
  problem: ProblemResponseWithTags,
  viewer: ProblemViewer,
): Promise<ProblemResponseWithTags> {
  const algorithmTags = problem.tags.filter((t) => t.kind === "algorithm");
  if (algorithmTags.length === 0) {
    return { ...problem, has_hidden_algorithm_tags: false };
  }

  // admin 与题主始终可见
  if (viewer.isAdmin) return { ...problem, has_hidden_algorithm_tags: false };
  if (viewer.userId && viewer.userId === problem.owner_id) {
    return { ...problem, has_hidden_algorithm_tags: false };
  }

  // 匿名用户：永不可见
  if (!viewer.userId) {
    return {
      ...problem,
      tags: problem.tags.filter((t) => t.kind !== "algorithm"),
      has_hidden_algorithm_tags: true,
    };
  }

  // 登录用户：有通过提交（finished 且 score>0）才可见
  const accepted = await hasAcceptedSubmission(problem.id, viewer.userId);
  if (accepted) {
    return { ...problem, has_hidden_algorithm_tags: false };
  }

  return {
    ...problem,
    tags: problem.tags.filter((t) => t.kind !== "algorithm"),
    has_hidden_algorithm_tags: true,
  };
}

/**
 * 查询 viewer 是否在指定题目存在通过提交（finished 且 score>0）。
 */
async function hasAcceptedSubmission(
  problemId: string,
  userId: string,
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: submissions.id })
    .from(submissions)
    .innerJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    )
    .where(
      and(
        eq(submissions.problem_id, problemId),
        eq(submissions.user_id, userId),
        eq(evaluationResults.status, "finished"),
        sql`${evaluationResults.score} > 0`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
