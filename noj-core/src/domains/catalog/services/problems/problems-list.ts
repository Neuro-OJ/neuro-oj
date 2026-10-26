/**
 * Problems 列表与查询（PR 拆分 PR-3；issue #223 分类 → 双类标签）。
 *
 * 提供：
 * - listProblems / listAllProblems：分页 + 多维筛选（?tag= 替代 ?category_id=）
 * - getProblem / getDefaultDomainProblemByNumber：单条查询（含全部标签）
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
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import {
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_SLUG,
} from "../../../../shared/workspace/types.ts";
import { loadWorkspace } from "../../../workspace/index.ts";
import {
  problemAuthoringRestrictedByContest,
  problemAuthoringRestrictionSql,
} from "../workspace/problem-contest-authoring.ts";
import { submissionQueryVisibility } from "../../../query/index.ts";
import {
  domains,
  problems,
  problemTags,
  submissions,
  tags,
  users,
} from "./../../../../shared/db/schema.ts";
import {
  BadRequestError,
  NotFoundError,
} from "./../../../../shared/base/errors.ts";
import { unendedPublicContestForProblem } from "./../../../contest/index.ts";
import type { TagKind } from "../tags.ts";
import {
  DIFFICULTIES,
  getJudgeBackend,
  getSubmissionLanguages,
  isValidDifficulty,
  type LlmConfig,
  type ProblemListQuery,
  type ProblemResponseWithTags,
  type ProblemRuntimeConfig,
  type ProblemTagRef,
} from "./../../types/problems.ts";
import type {
  AdminProblemListResponse,
  ProblemListResponse,
  ProblemResponse,
} from "./problems-types.ts";

function persistedJudgeType(value: string | null | undefined): "dual" | "oi" {
  return value === "oi" ? "oi" : "dual";
}

/**
 * 将数据库行转换为题目响应。
 *
 * 非 owner/admin 不返回 support_package_storage_url / runtime_config /
 * llm_config（JSON 序列化时省略字段，避免泄露评测与存储细节）。
 */
function toProblemResponse(
  row: typeof problems.$inferSelect,
  viewer: { isOwnerOrAdmin: boolean } = { isOwnerOrAdmin: true },
  isContestHidden = false,
): ProblemResponse {
  const base = {
    id: row.id,
    title: row.title,
    description: row.description,
    samples: (row.samples ??
      []) as import("../../types/problem-samples.ts").ProblemSample[],
    difficulty: row.difficulty,
    has_support_package: row.support_package_storage_url !== null,
    number: row.number,
    owner_id: row.owner_id,
    visibility: row.visibility as "public" | "private",
    is_objective: row.is_objective,
    judge_type: persistedJudgeType(row.judge_type),
    judge_backend: getJudgeBackend(
      row.judge_type,
      row.runtime_config,
      row.is_objective,
    ),
    supported_languages: getSubmissionLanguages(
      row.judge_type,
      row.runtime_config as ProblemRuntimeConfig | null,
    ),
    submission_mode: row.submission_mode as ProblemResponse["submission_mode"],
    artifact_max_size_mb: row.artifact_max_size_mb,
    display_id: String(row.number),
    domain_id: row.domain_id ?? DEFAULT_DOMAIN_ID,
    // 特权用户（admin/owner）看到"该题已被公开赛收编"的标记；对普通用户这些行
    // 根本不会出现，故恒为 false（审计 VULN-07）
    is_contest_hidden: viewer.isOwnerOrAdmin ? isContestHidden : false,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (!viewer.isOwnerOrAdmin) {
    return base;
  }
  return {
    ...base,
    support_package_storage_url: row.support_package_storage_url,
    runtime_config: row.runtime_config as ProblemRuntimeConfig,
    llm_config: row.llm_config as ProblemResponse["llm_config"],
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
  viewer: ProblemViewer = {},
): Promise<ProblemListResponse> {
  const db = getDb();
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(100, Math.max(1, query.limit ?? 20));
  const offset = (page - 1) * limit;

  // 构建筛选条件
  const conditions: SQL[] = [
    or(eq(problems.domain_id, DEFAULT_DOMAIN_ID), isNull(problems.domain_id))!,
  ];
  if (query.judge_type) {
    if (!["oi", "dual", "objective"].includes(query.judge_type)) {
      throw new BadRequestError("judge_type 仅允许 oi/dual/objective");
    }
    if (query.judge_type === "objective") {
      conditions.push(eq(problems.is_objective, true));
    } else {
      conditions.push(eq(problems.is_objective, false));
      conditions.push(
        sql`COALESCE(${problems.judge_type}, 'dual') = ${query.judge_type}`,
      );
    }
  }
  if (query.judge_backend) {
    if (!["dual", "oi-native", "oi-wasm"].includes(query.judge_backend)) {
      throw new BadRequestError("judge_backend 仅允许 dual/oi-native/oi-wasm");
    }
    conditions.push(eq(problems.is_objective, false));
    if (query.judge_backend === "dual") {
      conditions.push(sql`COALESCE(${problems.judge_type}, 'dual') = 'dual'`);
    } else {
      conditions.push(eq(problems.judge_type, "oi"));
      conditions.push(
        sql`${problems.runtime_config}->>'backend' = ${
          query.judge_backend.slice(3)
        }`,
      );
    }
  }

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
      })`,
    );
  }

  if ("type" in query) throw new BadRequestError("题库筛选已取消 P/U 分类");

  if (query.number !== undefined) {
    conditions.push(eq(problems.number, query.number));
  }

  if (query.owner_id) {
    conditions.push(eq(problems.owner_id, query.owner_id));
  }

  const workspace = await loadWorkspace(
    DEFAULT_DOMAIN_SLUG,
    viewer.userId ?? null,
  );
  const canManageAny = workspace.platformAdmin ||
    workspace.context.domainPermissions.has("problem:write_any");
  const canManageOwn = workspace.context.domainPermissions.has(
    "problem:write_own",
  );
  if (!workspace.membership && !canManageAny) {
    conditions.push(eq(problems.visibility, "public"));
  }
  if (!canManageAny) {
    conditions.push(
      or(
        isNotNull(problems.latest_version_id),
        canManageOwn && viewer.userId
          ? eq(problems.owner_id, viewer.userId)
          : sql`FALSE`,
      )!,
    );
    conditions.push(sql`(
      NOT (${
      unendedPublicContestForProblem(problems.id, sql`${DEFAULT_DOMAIN_ID}`)
    })
      OR (${canManageOwn} AND ${problems.owner_id} = ${viewer.userId ?? null})
    )`);
  }
  conditions.push(sql`NOT EXISTS (
    SELECT 1 FROM domain_problem_bindings b
    WHERE b.domain_id = ${DEFAULT_DOMAIN_ID} AND b.problem_id = ${problems.id}
      AND (b.disabled_at IS NOT NULL OR (${
    !workspace.membership && !canManageAny
  } AND b.visibility <> 'public'))
  )`);

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
      owner_avatar_url: users.avatar_url,
      // 是否被尚未结束的公开赛收编：与过滤条件同一谓词，语言层面不会漂移
      authoring_restricted: problemAuthoringRestrictionSql(
        workspace,
        problems.id,
      ).as("authoring_restricted"),
      is_contest_hidden: sql<boolean>`${
        unendedPublicContestForProblem(problems.id, sql`${DEFAULT_DOMAIN_ID}`)
      }`
        .as("is_contest_hidden"),
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
      ...toProblemResponse(r.problem, {
        isOwnerOrAdmin: !r.authoring_restricted && (canManageAny ||
          (canManageOwn && viewer.userId === r.problem.owner_id)),
      }, r.is_contest_hidden === true),
      owner_username: r.owner_username ?? "未知",
      owner_avatar_url: r.owner_avatar_url ?? null,
      tags: tagMap.get(r.problem.id) ?? [],
    })),
    total,
    page,
    limit,
  };
}

/**
 * 管理员获取全量题目列表（默认域完整题库）。
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
    visibility?: "public" | "private";
  } = {},
): Promise<AdminProblemListResponse> {
  const db = getDb();
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(100, Math.max(1, query.limit ?? 20));
  const offset = (page - 1) * limit;

  // 构建筛选条件（不默认添加 type='P'）
  const conditions: SQL[] = [
    or(eq(problems.domain_id, DEFAULT_DOMAIN_ID), isNull(problems.domain_id))!,
  ];

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

  if ("type" in query) throw new BadRequestError("题库筛选已取消 P/U 分类");

  if (query.visibility !== undefined) {
    if (query.visibility !== "public" && query.visibility !== "private") {
      throw new BadRequestError(
        `非法可见性：${query.visibility}，仅允许 public/private`,
      );
    }
    conditions.push(eq(problems.visibility, query.visibility));
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
      judge_type: problems.judge_type,
      llm_config: problems.llm_config,
      created_at: problems.created_at,
      updated_at: problems.updated_at,
      number: problems.number,
      owner_id: problems.owner_id,
      owner_username: users.username,
      visibility: problems.visibility,
      is_objective: problems.is_objective,
      submission_mode: problems.submission_mode,
      artifact_max_size_mb: problems.artifact_max_size_mb,
      // 管理端为特权视图：不过滤，但要能看出"该题正被公开赛保密"
      is_contest_hidden: sql<boolean>`${
        unendedPublicContestForProblem(problems.id, sql`${DEFAULT_DOMAIN_ID}`)
      }`
        .as("is_contest_hidden"),
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
      runtime_config: r.runtime_config as ProblemRuntimeConfig,
      judge_type: persistedJudgeType(r.judge_type),
      llm_config: r.llm_config as LlmConfig | null,
      tags: tagMap.get(r.id) ?? [],
      created_at: r.created_at,
      updated_at: r.updated_at,
      number: r.number,
      owner_id: r.owner_id,
      owner_username: r.owner_username ?? "未知",
      visibility: r.visibility as "public" | "private",
      is_objective: r.is_objective,
      submission_mode: r.submission_mode as ProblemResponse["submission_mode"],
      artifact_max_size_mb: r.artifact_max_size_mb,
      display_id: String(r.number),
      domain_id: DEFAULT_DOMAIN_ID,
      is_contest_hidden: r.is_contest_hidden === true,
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
  viewer?: ProblemViewer,
): Promise<ProblemResponseWithTags> {
  const db = getDb();

  const existing = await db
    .select({
      problem: problems,
      owner_username: users.username,
      owner_avatar_url: users.avatar_url,
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
    ...toProblemResponse(row.problem, {
      isOwnerOrAdmin: await canManageProblemProjection(row.problem, viewer),
    }),
    owner_username: row.owner_username ?? "未知",
    owner_avatar_url: row.owner_avatar_url ?? null,
    tags: tagMap.get(id) ?? [],
    has_hidden_algorithm_tags: false,
  };
}

/**
 * 按默认域数字题号查找源题；P 前缀仅在兼容入口解析。
 *
 * @throws {NotFoundError} 题目不存在
 */
export async function getDefaultDomainProblemByNumber(
  number: number,
  viewer?: ProblemViewer,
): Promise<ProblemResponseWithTags> {
  const db = getDb();

  const existing = await db
    .select({
      problem: problems,
      owner_username: users.username,
      owner_avatar_url: users.avatar_url,
    })
    .from(problems)
    .leftJoin(users, eq(problems.owner_id, users.id))
    .where(
      and(
        eq(problems.number, number),
        or(
          eq(problems.domain_id, DEFAULT_DOMAIN_ID),
          isNull(problems.domain_id),
        ),
      ),
    )
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("题目不存在");
  }

  const row = existing[0];
  const tagMap = await attachTags([row.problem.id]);
  return {
    ...toProblemResponse(row.problem, {
      isOwnerOrAdmin: await canManageProblemProjection(row.problem, viewer),
    }),
    owner_username: row.owner_username ?? "未知",
    owner_avatar_url: row.owner_avatar_url ?? null,
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

async function canManageProblemProjection(
  row: typeof problems.$inferSelect,
  viewer?: ProblemViewer,
) {
  if (viewer === undefined) return true; // 内部稳定主键读取，外部入口仍执行资源授权。
  const [domain] = await getDb().select({ slug: domains.slug }).from(domains)
    .where(eq(domains.id, row.domain_id ?? DEFAULT_DOMAIN_ID));
  if (!domain) return false;
  const workspace = await loadWorkspace(domain.slug, viewer.userId ?? null);
  return (workspace.platformAdmin ||
    workspace.context.domainPermissions.has("problem:write_any") ||
    (viewer.userId === row.owner_id &&
      workspace.context.domainPermissions.has("problem:write_own"))) &&
    !await problemAuthoringRestrictedByContest(workspace, row.id, getDb());
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
 * 查询 viewer 是否在指定题目存在**有效通过**提交。
 *
 * 版本化后（Handbook §3.4）通过状态改为读取提交的有效成绩投影
 * `submissions.is_accepted`：它由唯一投影服务按当前有效版本策略计算，
 * 覆盖历史版本、`exact(X)` 策略与升级提交，且命中索引
 * `idx_submissions_problem_accepted_user (problem_id, is_accepted, user_id)`。
 *
 * 存量数据由迁移 0103 回填投影，因此读取口径与旧 `acceptedResultSql` 完全一致。
 */
async function hasAcceptedSubmission(
  problemId: string,
  userId: string,
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(
        eq(submissions.problem_id, problemId),
        eq(submissions.user_id, userId),
        eq(submissions.is_accepted, true),
        submissionQueryVisibility(
          { domainId: DEFAULT_DOMAIN_ID, member: true },
          {
            domainId: submissions.domain_id,
            bindingId: submissions.domain_problem_binding_id,
            contestId: submissions.contest_id,
          },
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
