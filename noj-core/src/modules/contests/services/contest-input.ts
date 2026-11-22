// 竞赛输入规范化与校验：时间、计分配置、榜单策略、题目列表校验及题目可加入性断言，并含响应结构投影 toContestResponse。
import { eq, inArray } from "drizzle-orm";
import {
  contests,
  problems,
  problemVersions,
} from "../../../shared/db/schema.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import { type ProblemContentV1 } from "../../problems/types/problem-content.ts";
import { assertDefaultProblemSource } from "../../problems/contracts/cross-module/services_workspace_execution-context.ts";
import {
  computeContestStatus,
  normalizeContestTime,
} from "./contest-window.ts";
import {
  type ContestConfig,
  type ContestProblemInput,
  type ContestResponse,
  type ContestType,
  isValidContestConfig,
  isValidRankingVisibility,
} from "../types/contests.ts";
import { contestAllowsProblem } from "./contest-scoring.ts";

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
export function normalizeContestConfig(
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
export function validateTimes(startTime: string, endTime: string): void {
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
export function normalizeTimes(
  startTime: string,
  endTime: string,
): { start_time: string; end_time: string } {
  validateTimes(startTime, endTime);
  return {
    start_time: normalizeContestTime(startTime),
    end_time: normalizeContestTime(endTime),
  };
}

export function normalizeRankingPolicy(input: {
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
export function normalizeProblems(
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
export async function assertContestProblemAddable(
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
export function toContestResponse(
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
