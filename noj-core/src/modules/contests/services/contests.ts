import type { Executor } from "../../../shared/db/executor.ts";
import { rescheduleContestEducation } from "../../education/contracts/contest-facts.ts";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { enqueueSearchIndexTask } from "../../application/search-tasks.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
  problems,
  problemVersions,
  users,
} from "../../../shared/db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
} from "../../../shared/base/errors.ts";
import { getRedis } from "../../../shared/mq/connection.ts";
import {
  generatePublicId,
  resolvePublicId,
} from "../../../shared/security/public-id.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import {
  bumpProjectionRevision,
  globalScopeKey,
} from "../../evaluations/contracts/cross-module/services_versioning_projection.ts";
import { assertDefaultProblemSource } from "../../problems/contracts/cross-module/services_workspace_execution-context.ts";
import { type ProblemContentV1 } from "../../problems/types/problem-content.ts";
import { DEFAULT_DOMAIN_ID } from "../../../shared/workspace/types.ts";
import { ensureDefaultWorkspace } from "../../access/contracts/cross-module/workspace_services_domains.ts";
import { findContestRow } from "./contest-row.ts";
import { resolveDomainContestProblems } from "./domain-problems.ts";
import { contestAllowsProblem } from "./contest-scoring.ts";
import {
  computeContestStatus,
  normalizeContestTime,
} from "./contest-window.ts";
export { computeContestStatus } from "./contest-window.ts";
import {
  type ContestConfig,
  type ContestProblemInput,
  type ContestResponse,
  type ContestType,
  type CreateContestInput,
  isValidContestConfig,
  isValidContestType,
  isValidRankingVisibility,
  type UpdateContestInput,
} from "../types/contests.ts";

/** 竞赛列表查询参数（分页、按类型筛选、是否包含非公开竞赛）。 */
export interface ListContestsParams {
  page?: number;
  perPage?: number;
  type?: ContestType;
  showAll?: boolean;
  /** 旧 API 固定默认域，显式域列表由专用授权入口提供。 */
  defaultDomainOnly?: boolean;
}

/** 竞赛列表查询结果（分页数据与总数）。 */
export interface ListContestsResult {
  data: ContestResponse[];
  total: number;
}

/** 竞赛参与者响应结构。 */
export interface ContestParticipantResponse {
  user_id: string;
  username: string;
  avatar_url: string | null;
  registered_at: string;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** 返回指定类型竞赛的默认配置（当前为空配置）。 */
function defaultContestConfig(_type: ContestType): ContestConfig {
  return _type === "acm"
    ? { penalty_minutes: 20 }
    : _type === "kaggle"
    ? { scoreboard_scope: "self" }
    : {};
}

/**
 * 规范化竞赛配置：无配置时使用默认配置，并校验配置合法性。
 *
 * @param _type 竞赛类型
 * @param config 传入的竞赛配置（可选）
 * @returns 规范化后的竞赛配置（仅保留合法的 submission_limits 等字段）
 * @throws {BadRequestError} 配置不合法时
 */
function normalizeContestConfig(
  _type: ContestType,
  config: ContestConfig | undefined,
): ContestConfig {
  const value = config ?? defaultContestConfig(_type);
  if (!isValidContestConfig(_type, value)) {
    throw new BadRequestError("竞赛配置不合法");
  }

  const raw = value as Record<string, unknown>;
  const submissionLimits = raw.submission_limits as
    | Record<string, number>
    | undefined;
  return {
    ...(submissionLimits ? { submission_limits: submissionLimits } : {}),
    ...(_type === "acm"
      ? { penalty_minutes: value.penalty_minutes ?? 20 }
      : {}),
    ...(_type === "kaggle"
      ? { scoreboard_scope: value.scoreboard_scope ?? "self" }
      : {}),
  };
}

/**
 * 校验竞赛开始/结束时间：必须是合法 ISO 8601 时间，且结束时间晚于开始时间。
 *
 * 注意本函数**只校验、不规范化**；规范化由 {@link normalizeContestTime} 在写入前
 * 统一完成（2026-09-14 评审 C1：此前"原样落库"让 `+08:00` 等合法形态进入文本列，
 * 使按字典序比较的门控谓词静默 fail-open）。
 *
 * @param startTime 开始时间字符串
 * @param endTime 结束时间字符串
 * @throws {BadRequestError} 时间格式非法或结束时间不晚于开始时间时
 */
function validateTimes(startTime: string, endTime: string): void {
  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new BadRequestError(
      "start_time 和 end_time 必须为合法 ISO 8601 时间",
    );
  }
  if (end <= start) {
    throw new BadRequestError("end_time 必须晚于 start_time");
  }
}

/**
 * 校验并**规范化**竞赛时间，返回可安全落库的规范形态。
 *
 * 这是 C1 的**最高杠杆单点修复**：写侧统一规范化后，文本列中不再出现
 * `+08:00` / 秒级精度等"合法但形态各异"的值，任何按时刻比较的读侧判定
 * （含 `::timestamptz` 转换）都不会再被形态差异欺骗。
 *
 * @param startTime 开始时间（任意合法 ISO 8601 形态）。
 * @param endTime 结束时间（同上）。
 * @returns 规范形态的 `{ start_time, end_time }`。
 * @throws {BadRequestError} 时间非法或结束不晚于开始时。
 */
function normalizeTimes(
  startTime: string,
  endTime: string,
): { start_time: string; end_time: string } {
  validateTimes(startTime, endTime);
  return {
    start_time: normalizeContestTime(startTime),
    end_time: normalizeContestTime(endTime),
  };
}

function normalizeRankingPolicy(input: {
  start_time: string;
  end_time: string;
  ranking_visibility?: string;
  freeze_start_time?: string | null;
  freeze_duration_seconds?: number;
}): {
  ranking_visibility: ContestResponse["ranking_visibility"];
  freeze_start_time: string | null;
  freeze_duration_seconds: number;
} {
  const visibility = input.ranking_visibility ?? "public";
  if (!isValidRankingVisibility(visibility)) {
    throw new BadRequestError(
      "榜单可见性必须为 public、participants 或 hidden",
    );
  }
  const duration = input.freeze_duration_seconds ?? 0;
  if (!Number.isInteger(duration) || duration < 0) {
    throw new BadRequestError("封榜时长必须为非负整数秒");
  }
  const start = Date.parse(input.start_time);
  const end = Date.parse(input.end_time);
  const rawExplicit = input.freeze_start_time ?? null;
  // 规范化封榜时间：迁移 0083 的形态 CHECK 也约束 freeze_start_time，
  // 原样落库会因非规范形态（如 +08:00）被约束拒绝（2026-09-14 评审 C1）
  const explicit = rawExplicit === null
    ? null
    : normalizeContestTime(rawExplicit);
  if (explicit !== null) {
    const freezeStart = Date.parse(explicit);
    if (
      Number.isNaN(freezeStart) || freezeStart < start || freezeStart >= end
    ) {
      throw new BadRequestError("freeze_start_time 必须位于竞赛开始与结束之间");
    }
    if (duration !== 0) {
      throw new BadRequestError(
        "freeze_start_time 与 freeze_duration_seconds 只能配置一个",
      );
    }
  }
  if (duration > Math.floor((end - start) / 1000)) {
    throw new BadRequestError("封榜时长不能超过竞赛总时长");
  }
  return {
    ranking_visibility: visibility,
    freeze_start_time: explicit,
    freeze_duration_seconds: duration,
  };
}

/**
 * 规范化竞赛题目列表：去除首尾空白并校验字段唯一性与取值合法性。
 *
 * @param _type 竞赛类型
 * @param values 传入的竞赛题目输入列表
 * @returns 规范化后的竞赛题目列表
 * @throws {BadRequestError} 题目为空、字段缺失、重复或取值非法时
 */
function normalizeProblems(
  _type: ContestType,
  values: ContestProblemInput[],
): ContestProblemInput[] {
  if (values.length === 0) {
    throw new BadRequestError("竞赛至少需要一道题目");
  }

  const problemIds = new Set<string>();
  const labels = new Set<string>();
  const sortOrders = new Set<number>();

  return values.map((value) => {
    const problemId = value.problem_id.trim();
    const label = value.label.trim();
    if (!problemId || !label) {
      throw new BadRequestError("竞赛题目 ID 和标签不能为空");
    }
    if (!Number.isInteger(value.sort_order) || value.sort_order < 0) {
      throw new BadRequestError("竞赛题目 sort_order 必须为非负整数");
    }
    if (
      value.score === undefined || value.score === null ||
      !Number.isInteger(value.score) || value.score < 0
    ) {
      throw new BadRequestError("竞赛题目 score 必须为非负整数");
    }
    if (problemIds.has(problemId)) {
      throw new BadRequestError("竞赛题目不能重复");
    }
    if (labels.has(label)) {
      throw new BadRequestError("竞赛题目标签不能重复");
    }
    if (sortOrders.has(value.sort_order)) {
      throw new BadRequestError("竞赛题目排序值不能重复");
    }

    problemIds.add(problemId);
    labels.add(label);
    sortOrders.add(value.sort_order);
    return {
      problem_id: problemId,
      label,
      sort_order: value.sort_order,
      score: value.score,
    };
  });
}

/**
 * 断言竞赛题目均可加入：题目必须真实存在、**已发布至少一个版本**；
 * 普通用户只能加入 public 题或自己拥有的题（堵“造竞赛上下文套他人私有题”洞）。
 *
 * 同时返回各题当前的最新已发布版本，供调用方写入竞赛固定版本
 * （`contest_problems.pinned_version_id`，Handbook §2.6/§4.1「竞赛默认 = 固定版本」）。
 * 未发布题目不能加入竞赛：固定版本是竞赛作答与判卷的唯一来源，空固定版本会让
 * 竞赛题目无法确定"评哪一版"。
 *
 * @param problemInputs 竞赛题目输入列表
 * @param creatorId 竞赛创建者/更新者用户 ID
 * @param isAdmin 是否为管理员
 * @param db 数据库连接或事务对象
 * @returns problem_id → 最新已发布版本 ID（保证非空）
 * @throws {BadRequestError} 存在不存在或尚未发布任何版本的题目时
 * @throws {ForbiddenError} 普通用户加入他人私有题时
 */
async function assertContestProblemAddable(
  problemInputs: ContestProblemInput[],
  _creatorId: string,
  _isAdmin: boolean,
  // deno-lint-ignore no-explicit-any -- postgres.js 事务共享接口
  db: any,
  type: ContestType,
): Promise<Map<string, string>> {
  const ids = problemInputs.map((value) => value.problem_id);
  const rows = await db.select({
    id: problems.id,
    owner_id: problems.owner_id,
    visibility: problems.visibility,
    latest_version_id: problems.latest_version_id,
    content: problemVersions.content,
    domain_id: problems.domain_id,
  }).from(problems).leftJoin(
    problemVersions,
    eq(problemVersions.id, problems.latest_version_id),
  )
    .where(inArray(problems.id, ids));
  if (rows.length !== ids.length) {
    throw new BadRequestError("竞赛包含不存在的题目");
  }
  for (const row of rows) assertDefaultProblemSource(row);
  const unpublished = rows.filter(
    (row: { latest_version_id: string | null }) => !row.latest_version_id,
  );
  if (unpublished.length > 0) {
    // 固定版本不可为空（NOT NULL + 复合外键）；未发布题目必须先发布版本
    throw new BadRequestError(
      `竞赛只能包含已发布题目：${unpublished.length} 道题尚未发布任何版本（请先发布题目版本）`,
    );
  }
  for (const row of rows as Array<{ content: ProblemContentV1 }>) {
    if (!contestAllowsProblem(type, row.content.kind)) {
      throw new BadRequestError("此赛制不允许所选题型");
    }
  }
  return new Map(
    rows.map((
      row: { id: string; latest_version_id: string | null },
    ) => [row.id, row.latest_version_id as string]),
  );
}

/**
 * 将竞赛数据库行转换为对外响应结构。
 *
 * @param row 竞赛数据行（含题目数与参与者数统计）
 * @param isRegistered 当前用户是否已注册（可选，缺省则响应中不包含该字段）
 * @returns 竞赛响应对象
 */
function toContestResponse(
  row: typeof contests.$inferSelect & {
    problem_count: number;
    participant_count: number;
  },
  isRegistered?: boolean,
): ContestResponse {
  return {
    id: row.id,
    domain_id: row.domain_id,
    revision: row.revision,
    public_id: row.public_id,
    title: row.title,
    description: row.description,
    start_time: row.start_time,
    end_time: row.end_time,
    type: row.type as ContestType,
    ranking_visibility: row
      .ranking_visibility as ContestResponse["ranking_visibility"],
    freeze_start_time: row.freeze_start_time,
    freeze_duration_seconds: row.freeze_duration_seconds,
    secrecy_enabled: row.secrecy_enabled,
    config: row.config as ContestConfig,
    affect_global_ranking: row.affect_global_ranking,
    created_by: row.created_by,
    announcement: row.announcement,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: computeContestStatus(row.start_time, row.end_time),
    problem_count: Number(row.problem_count),
    participant_count: Number(row.participant_count),
    ...(isRegistered === undefined ? {} : { is_registered: isRegistered }),
  };
}

/** 将 UUID 或 public_id 解析为内部竞赛 UUID；其它格式按主键兜底（兼容旧数据）。 */
export function resolveContestId(value: string): Promise<string> {
  return resolvePublicId(
    contests,
    contests.id,
    contests.public_id,
    "ct",
    value,
    "竞赛不存在",
  );
}

/**
 * 创建竞赛：校验输入、规范化配置与题目，事务写入竞赛及题目关联。
 *
 * @param input 创建竞赛的输入
 * @param userId 创建者用户 ID
 * @returns 创建后的竞赛响应
 * @throws {BadRequestError} 输入不合法（标题/类型/时间/配置/题目）时
 */
export async function createContest(
  input: CreateContestInput,
  userId: string,
  isAdmin = false,
  options: {
    executor?: Executor;
    domainId?: string;
    versions?: Map<string, string>;
    bindings?: Map<string, string>;
  } = {},
): Promise<ContestResponse> {
  if (!input.title.trim()) {
    throw new BadRequestError("竞赛标题不能为空");
  }
  if (!isValidContestType(input.type)) {
    throw new BadRequestError("竞赛类型不合法");
  }
  if (
    input.secrecy_enabled !== undefined &&
    typeof input.secrecy_enabled !== "boolean"
  ) {
    throw new BadRequestError("赛题保护必须为布尔值");
  }
  // 校验 + 规范化：落库形态统一为 toISOString()，保证读侧按时刻比较安全（C1）
  const times = normalizeTimes(input.start_time, input.end_time);
  const rankingPolicy = normalizeRankingPolicy({
    ...input,
    start_time: times.start_time,
    end_time: times.end_time,
    ranking_visibility: input.ranking_visibility ??
      (input.type === "oi"
        ? "hidden"
        : input.type === "kaggle"
        ? "public"
        : "participants"),
    freeze_duration_seconds: input.freeze_duration_seconds ?? (
      input.type === "acm" && !input.freeze_start_time
        ? Math.min(
          3600,
          Math.floor(
            (Date.parse(times.end_time) - Date.parse(times.start_time)) / 1000,
          ),
        )
        : 0
    ),
  });
  const config = normalizeContestConfig(input.type, input.config);
  const problemInputs = normalizeProblems(input.type, input.problems);
  const id = crypto.randomUUID();
  const publicId = generatePublicId("ct");
  const now = new Date().toISOString();
  const db = options.executor ?? getDb();

  await db.transaction(async (tx) => {
    if (!options.domainId) await ensureDefaultWorkspace(tx);
    const domainId = options.domainId ?? DEFAULT_DOMAIN_ID;
    const latestVersions = options.versions ??
      await assertContestProblemAddable(
        problemInputs,
        userId,
        isAdmin,
        tx,
        input.type,
      );
    const bindings = options.bindings ?? (await resolveDomainContestProblems(
      tx,
      domainId,
      problemInputs.map((problem) => problem.problem_id),
      input.type,
    )).bindingIds;
    await tx.insert(contests).values({
      id,
      domain_id: domainId,
      public_id: publicId,
      title: input.title.trim(),
      description: input.description ?? "",
      start_time: times.start_time,
      end_time: times.end_time,
      ...rankingPolicy,
      type: input.type,
      kind: "public",
      secrecy_enabled: input.secrecy_enabled ?? true,
      config,
      // 旧字段不再参与授权，统一写入中性值。
      is_public: true,
      password: null,
      affect_global_ranking: input.affect_global_ranking ?? false,
      created_by: userId,
      announcement: input.announcement ?? "",
      created_at: now,
      updated_at: now,
    });
    await tx.insert(contestProblems).values(
      problemInputs.map((value) => ({
        contest_id: id,
        domain_id: domainId,
        domain_problem_binding_id: bindings.get(value.problem_id)!,
        ...value,
        // 创建即固定版本：钉在当时的已发布最新版，之后题库发布新版本不影响本竞赛
        // （换版必须走显式的「竞赛固定版本升级」操作，Handbook §4.1/§4.3）。
        pinned_version_id: latestVersions.get(value.problem_id)!,
      })),
    );
  });

  await enqueueSearchIndexTask("contest", id, "upsert", db);

  return getContest(id, undefined, db);
}

/**
 * 更新竞赛：仅更新传入的字段，并同步更新题目关联（若提供）。
 *
 * @param id 竞赛 UUID
 * @param input 更新竞赛的输入
 * @returns 更新后的竞赛响应
 * @throws {NotFoundError} 竞赛不存在时
 * @throws {BadRequestError} 输入不合法（类型/时间/配置/题目）时
 */
export async function updateContest(
  id: string,
  input: UpdateContestInput,
  isAdmin = false,
  options: {
    executor?: Executor;
    versions?: Map<string, string>;
    domainId?: string;
    bindings?: Map<string, string>;
  } = {},
): Promise<ContestResponse> {
  const existing = await findContestRow(id, options.executor);
  const type = input.type ?? existing.type as ContestType;
  if (!isValidContestType(type)) {
    throw new BadRequestError("竞赛类型不合法");
  }
  if (
    input.secrecy_enabled !== undefined &&
    typeof input.secrecy_enabled !== "boolean"
  ) {
    throw new BadRequestError("赛题保护必须为布尔值");
  }
  // 合并后的时间同样校验 + 规范化：既防新写入脏形态，也顺带把存量非规范行
  // （如带 +08:00 偏移的旧数据）收敛为规范形态（C1）
  const times = normalizeTimes(
    input.start_time ?? existing.start_time,
    input.end_time ?? existing.end_time,
  );
  const rankingPolicy = normalizeRankingPolicy({
    start_time: times.start_time,
    end_time: times.end_time,
    ranking_visibility: input.ranking_visibility ?? existing.ranking_visibility,
    freeze_start_time: input.freeze_start_time !== undefined
      ? input.freeze_start_time
      : existing.freeze_start_time,
    freeze_duration_seconds: input.freeze_duration_seconds ??
      existing.freeze_duration_seconds,
  });
  if (input.title !== undefined && !input.title.trim()) {
    throw new BadRequestError("竞赛标题不能为空");
  }

  const config = input.config !== undefined || input.type !== undefined
    ? normalizeContestConfig(type, input.config)
    : existing.config as ContestConfig;
  const problemInputs = input.problems === undefined
    ? undefined
    : normalizeProblems(type, input.problems);
  const db = options.executor ?? getDb();
  /** 本次更新涉及题目的最新已发布版本（在事务内校验题目可加入时一并取得）。 */
  let latestVersions: Map<string, string> | null = null;
  let bindings: Map<string, string> | null = null;
  const domainId = options.domainId ?? DEFAULT_DOMAIN_ID;
  if ((existing.domain_id ?? DEFAULT_DOMAIN_ID) !== domainId) {
    throw new NotFoundError("竞赛不存在");
  }

  await db.transaction(async (tx) => {
    const previousProblems = await tx.select({
      problem_id: contestProblems.problem_id,
    }).from(contestProblems).where(eq(contestProblems.contest_id, id));
    const hostIds = [
      ...new Set([
        ...previousProblems.map((row) => row.problem_id),
        ...(problemInputs ?? []).map((row) => row.problem_id),
      ]),
    ].sort();
    if (hostIds.length) {
      await tx.select({ id: problems.id }).from(problems).where(
        inArray(problems.id, hostIds),
      ).orderBy(problems.id).for("share");
    }
    const [locked] = await tx.select().from(contests).where(
      eq(contests.id, id),
    ).for("update");
    if (locked.type !== existing.type) {
      throw new ConflictError("赛制已变化，请重新读取比赛");
    }
    if (
      Date.now() >= Date.parse(locked.start_time) &&
      (input.type !== undefined && input.type !== locked.type ||
        input.config !== undefined || input.freeze_start_time !== undefined ||
        input.freeze_duration_seconds !== undefined ||
        input.secrecy_enabled !== undefined)
    ) {
      throw new ConflictError("开赛后不能修改赛制或计分配置");
    }
    if (problemInputs) {
      latestVersions = options.versions ?? await assertContestProblemAddable(
        problemInputs,
        existing.created_by ?? "",
        isAdmin,
        tx,
        type,
      );
      bindings = options.bindings ?? (await resolveDomainContestProblems(
        tx,
        domainId,
        problemInputs.map((problem) => problem.problem_id),
        type,
      )).bindingIds;
    } else if (type !== existing.type) {
      // 只切换赛制也要校验已选题目的固定版本，不能留下错误题型。
      const selected = await tx.select({ content: problemVersions.content })
        .from(contestProblems).innerJoin(
          problemVersions,
          eq(problemVersions.id, contestProblems.pinned_version_id),
        )
        .where(eq(contestProblems.contest_id, id));
      if (
        selected.some((row) =>
          !contestAllowsProblem(type, (row.content as ProblemContentV1).kind)
        )
      ) {
        throw new BadRequestError("新赛制不允许现有题目类型");
      }
    }

    const updates: Partial<typeof contests.$inferInsert> = {
      updated_at: new Date().toISOString(),
    };
    if (input.title !== undefined) updates.title = input.title.trim();
    if (input.description !== undefined) {
      updates.description = input.description;
    }
    if (input.start_time !== undefined) updates.start_time = times.start_time;
    if (input.end_time !== undefined) updates.end_time = times.end_time;
    if (input.ranking_visibility !== undefined) {
      updates.ranking_visibility = rankingPolicy.ranking_visibility;
    }
    if (input.freeze_start_time !== undefined) {
      updates.freeze_start_time = rankingPolicy.freeze_start_time;
    }
    if (input.freeze_duration_seconds !== undefined) {
      updates.freeze_duration_seconds = rankingPolicy.freeze_duration_seconds;
    }
    if (input.type !== undefined) updates.type = input.type;
    if (input.secrecy_enabled !== undefined) {
      updates.secrecy_enabled = input.secrecy_enabled;
    }
    // 访问由 Domain 决定，历史比赛分类与密码不再控制报名。
    updates.is_public = true;
    updates.kind = "public";
    updates.password = null;
    if (input.config !== undefined || input.type !== undefined) {
      updates.config = config;
    }
    if (input.affect_global_ranking !== undefined) {
      updates.affect_global_ranking = input.affect_global_ranking;
    }
    if (input.announcement !== undefined) {
      updates.announcement = input.announcement;
    }

    await tx.update(contests).set(updates).where(eq(contests.id, id));
    if (
      updates.end_time !== undefined && updates.end_time !== existing.end_time
    ) {
      await rescheduleContestEducation(tx, id, updates.end_time);
    }

    // 全站榜口径失效（2026-10-11 复审问题 8）：全站排名的过滤条件包含
    // `contests.end_time`（赛期结束才计入）与 `affect_global_ranking`，而时钟跨越
    // end_time 或这两列被修改都不产生任何提交/判定写入——不递增 revision，
    // 缓存与物化视图就会继续按旧口径命中。这里复用唯一递增入口
    // （`bumpProjectionRevision`），与投影/策略路径同一套缓存失效语义。
    if (
      input.start_time !== undefined ||
      input.end_time !== undefined ||
      input.affect_global_ranking !== undefined
    ) {
      await bumpProjectionRevision(tx, globalScopeKey());
    }

    if (problemInputs) {
      // 题目关联是「整体替换」：必须先读旧固定版本，否则编辑竞赛（改名/改时间）
      // 会把已固定的版本重置到最新版，等于静默换版（Handbook §4.3）。
      const previousBindings = new Map(
        (await tx.select().from(contestProblems).where(
          eq(contestProblems.contest_id, id),
        )).map((row) => [row.problem_id, row]),
      );
      await tx.delete(contestProblems).where(
        eq(contestProblems.contest_id, id),
      );
      await tx.insert(contestProblems).values(
        problemInputs.map((value) => {
          // 已有固定版本原样保留（编辑竞赛不得静默换版）；新加入的题目用本次
          // 解析出的最新已发布版本（assert 已保证存在，未发布题目直接 400）。
          const binding = previousBindings.get(value.problem_id);
          return {
            contest_id: id,
            domain_id: domainId,
            domain_problem_binding_id: bindings!.get(value.problem_id)!,
            ...value,
            pinned_version_id: binding?.pinned_version_id ??
              latestVersions!.get(value.problem_id)!,
            effective_version_mode: binding?.effective_version_mode ?? "any",
            required_version_id: binding?.required_version_id ?? null,
            effective_policy_revision: binding?.effective_policy_revision ?? 0,
          };
        }),
      );
    }
  });

  await enqueueSearchIndexTask("contest", id, "upsert", db);

  return getContest(id, undefined, db);
}

/**
 * 删除竞赛。
 *
 * @param id 竞赛 UUID
 * @throws {NotFoundError} 竞赛不存在时
 */
export async function deleteContest(id: string): Promise<void> {
  const db = getDb();
  const deleted = await db.delete(contests).where(eq(contests.id, id))
    .returning({
      id: contests.id,
    });
  if (deleted.length === 0) {
    throw new NotFoundError("竞赛不存在");
  }

  // 删除竞赛会把 `submissions.contest_id` 置空（onDelete set null），这些提交从
  // "竞赛口径"回到"练习口径"，全站榜的过滤与通过口径随之变化 → 立即递增 global
  // data revision（2026-10-11 复审问题 8；与题目/策略路径共用同一入口）。
  await bumpProjectionRevision(db, globalScopeKey());

  await enqueueSearchIndexTask("contest", id, "delete", db);
}

/**
 * 获取竞赛详情（含题目数、参与者数；若提供用户则含其注册状态）。
 *
 * @param id 竞赛 UUID
 * @param userId 当前用户 ID（可选）
 * @returns 竞赛响应
 * @throws {NotFoundError} 竞赛不存在时
 */
export async function getContest(
  id: string,
  userId?: string,
  executor?: Executor,
): Promise<ContestResponse> {
  const db = executor ?? getDb();
  const rows = await db.execute(sql`
    SELECT c.*,
      (SELECT COUNT(*)::int FROM contest_problems cp WHERE cp.contest_id = c.id) AS problem_count,
      (SELECT COUNT(*)::int FROM contest_participants cpa WHERE cpa.contest_id = c.id) AS participant_count
    FROM contests c
    WHERE c.id = ${id}
    LIMIT 1
  `);
  const [row] = unwrapRows<
    typeof contests.$inferSelect & {
      problem_count: number;
      participant_count: number;
    }
  >(rows as never);
  if (!row) {
    throw new NotFoundError("竞赛不存在");
  }
  const registered = userId === undefined
    ? undefined
    : await isParticipant(id, userId, db);
  return toContestResponse(row, registered);
}

/**
 * 分页查询竞赛列表（默认仅公开竞赛，可按类型筛选）。
 *
 * @param params 查询参数（分页、类型、是否包含非公开）
 * @returns 竞赛列表与总数
 * @throws {BadRequestError} 分页或类型参数不合法时
 */
export async function listContests(
  params: ListContestsParams = {},
): Promise<ListContestsResult> {
  const page = params.page ?? 1;
  const perPage = params.perPage ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(page) || page < 1) {
    throw new BadRequestError("page 必须为正整数");
  }
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > MAX_PAGE_SIZE) {
    throw new BadRequestError(`perPage 必须为 1-${MAX_PAGE_SIZE} 的整数`);
  }
  if (params.type && !isValidContestType(params.type)) {
    throw new BadRequestError("竞赛类型不合法");
  }

  const conditions = [];
  if (params.defaultDomainOnly) {
    conditions.push(
      or(
        eq(contests.domain_id, DEFAULT_DOMAIN_ID),
        isNull(contests.domain_id),
      )!,
    );
  }
  if (params.type) conditions.push(eq(contests.type, params.type));
  const where = conditions.length === 0 ? undefined : and(...conditions);
  const db = getDb();
  const [countRow] = await db.select({ total: sql<number>`COUNT(*)` }).from(
    contests,
  ).where(where);
  const total = Number(countRow?.total ?? 0);
  if (total === 0) return { data: [], total: 0 };

  const rows = await db.execute(sql`
    SELECT c.*,
      (SELECT COUNT(*)::int FROM contest_problems cp WHERE cp.contest_id = c.id) AS problem_count,
      (SELECT COUNT(*)::int FROM contest_participants cpa WHERE cpa.contest_id = c.id) AS participant_count
    FROM contests c
    WHERE TRUE
      ${
    params.defaultDomainOnly
      ? sql`AND (c.domain_id = ${DEFAULT_DOMAIN_ID} OR c.domain_id IS NULL)`
      : sql``
  }
      ${params.type ? sql`AND c.type = ${params.type}` : sql``}
    ORDER BY c.start_time DESC, c.id ASC
    LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
  `);
  const data = unwrapRows<
    typeof contests.$inferSelect & {
      problem_count: number;
      participant_count: number;
    }
  >(rows as never).map((row) => toContestResponse(row));
  return { data, total };
}

/**
 * 用户注册参赛：
 * 已具备本域访问权的用户按比赛状态自助报名。
 *
 * @param contestId 竞赛 UUID
 * @param userId 用户 ID
 * @throws {ForbiddenError} 竞赛已结束或域访问被拒时
 * @throws {ConflictError} 已注册该竞赛时
 */
export async function registerForContest(
  contestId: string,
  userId: string,
  executor?: Executor,
): Promise<void> {
  const contest = await findContestRow(contestId, executor);
  if (computeContestStatus(contest.start_time, contest.end_time) === "ended") {
    throw new ForbiddenError("竞赛已结束，无法注册");
  }

  const db = executor ?? getDb();
  const inserted = await db.insert(contestParticipants).values({
    contest_id: contestId,
    user_id: userId,
    registered_at: new Date().toISOString(),
  }).onConflictDoNothing().returning({ user_id: contestParticipants.user_id });
  if (inserted.length === 0) {
    throw new ConflictError("已注册该竞赛");
  }

  await enqueueSearchIndexTask("contest", contestId, "upsert", db);
}

/**
 * 批量添加竞赛参与者（已存在的用户自动跳过）。
 *
 * @param contestId 竞赛 UUID
 * @param userIds 待添加的用户 ID 列表
 * @returns 实际新增的参与者数量
 * @throws {NotFoundError} 竞赛不存在时
 * @throws {BadRequestError} 参与者列表为空或包含不存在的用户时
 */
export async function addParticipants(
  contestId: string,
  userIds: string[],
): Promise<number> {
  await findContestRow(contestId);
  const uniqueUserIds = [
    ...new Set(userIds.map((id) => id.trim()).filter(Boolean)),
  ];
  if (uniqueUserIds.length === 0) {
    throw new BadRequestError("参与者列表不能为空");
  }

  const db = getDb();
  const existingUsers = await db.select({ id: users.id }).from(users).where(
    inArray(users.id, uniqueUserIds),
  );
  if (existingUsers.length !== uniqueUserIds.length) {
    throw new BadRequestError("参与者列表包含不存在的用户");
  }
  const registeredAt = new Date().toISOString();
  const inserted = await db.insert(contestParticipants).values(
    uniqueUserIds.map((userId) => ({
      contest_id: contestId,
      user_id: userId,
      registered_at: registeredAt,
    })),
  ).onConflictDoNothing().returning({ user_id: contestParticipants.user_id });

  await enqueueSearchIndexTask("contest", contestId, "upsert", db);

  return inserted.length;
}

/**
 * 移除竞赛的某位参与者。
 *
 * @param contestId 竞赛 UUID
 * @param userId 待移除的用户 ID
 * @throws {NotFoundError} 竞赛参与者不存在时
 */
export async function removeParticipant(
  contestId: string,
  userId: string,
): Promise<void> {
  const db = getDb();
  const deleted = await db.delete(contestParticipants).where(
    and(
      eq(contestParticipants.contest_id, contestId),
      eq(contestParticipants.user_id, userId),
    ),
  ).returning({ user_id: contestParticipants.user_id });
  if (deleted.length === 0) {
    throw new NotFoundError("竞赛参与者不存在");
  }

  await enqueueSearchIndexTask("contest", contestId, "upsert", db);
}

/**
 * 列出竞赛的全部参与者（按注册时间升序）。
 *
 * @param contestId 竞赛 UUID
 * @returns 参与者响应列表
 * @throws {NotFoundError} 竞赛不存在时
 */
export async function listParticipants(
  contestId: string,
): Promise<ContestParticipantResponse[]> {
  await findContestRow(contestId);
  const db = getDb();
  return db.select({
    user_id: contestParticipants.user_id,
    username: users.username,
    avatar_url: users.avatar_url,
    registered_at: contestParticipants.registered_at,
  }).from(contestParticipants).innerJoin(
    users,
    eq(users.id, contestParticipants.user_id),
  ).where(eq(contestParticipants.contest_id, contestId)).orderBy(
    asc(contestParticipants.registered_at),
    asc(contestParticipants.user_id),
  );
}

/**
 * 校验比赛内每道题提交次数上限（Redis 原子预算）。
 * 未配置 `submission_limits` 的题目不限制；所有提交（含 error）都计入。
 * 键 TTL 指到竞赛截止时间，超限抛 429 RateLimitedError。
 *
 * @throws {RateLimitedError} 达到上限时
 */
export async function assertContestSubmissionLimit(
  contestId: string,
  userId: string,
  problemId: string,
  reservationId?: string,
): Promise<void> {
  const contest = await findContestRow(contestId);
  const config = contest.config as ContestConfig;
  const limit = config.submission_limits?.[problemId];
  if (!limit) return;

  const redis = getRedis();
  const key = `contest:lim:${contestId}:u:${userId}:p:${problemId}`;
  const ttl = Math.max(
    1,
    Math.floor((Date.parse(contest.end_time) - Date.now()) / 1000),
  );
  if (reservationId) {
    const reserved = Number(
      await redis.eval(
        `
      if redis.call('EXISTS', KEYS[2]) == 1 then return 1 end
      if tonumber(redis.call('GET', KEYS[1]) or '0') >= tonumber(ARGV[1]) then return 0 end
      redis.call('INCR', KEYS[1])
      redis.call('EXPIRE', KEYS[1], ARGV[2])
      redis.call('SET', KEYS[2], '1', 'EX', ARGV[2])
      return 1
    `,
        2,
        key,
        `${key}:reservation:${reservationId}`,
        limit,
        ttl,
      ),
    );
    if (!reserved) throw new RateLimitedError("提交次数已达上限");
    return;
  }
  const used = await redis.incr(key);
  if (used === 1) {
    const ttl = Math.max(
      1,
      Math.floor((Date.parse(contest.end_time) - Date.now()) / 1000),
    );
    await redis.expire(key, ttl);
  }
  if (used > limit) {
    throw new RateLimitedError("提交次数已达上限");
  }
}

/**
 * 判断用户是否为某竞赛的参与者。
 *
 * @param contestId 竞赛 UUID
 * @param userId 用户 ID
 * @returns 是否已参赛
 */
export async function isParticipant(
  contestId: string,
  userId: string,
  executor: Executor = getDb(),
): Promise<boolean> {
  const db = executor;
  const [row] = await db.select({ user_id: contestParticipants.user_id }).from(
    contestParticipants,
  ).where(
    and(
      eq(contestParticipants.contest_id, contestId),
      eq(contestParticipants.user_id, userId),
    ),
  ).limit(1);
  return row !== undefined;
}

export { getContestProblems } from "./contest-problems.ts";
