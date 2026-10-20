import {
  oiVerdict,
  projectMeteringDetails,
  projectOiDetails,
} from "./oi-details.ts";
import type { ContestType } from "../../../../modules/contests/index.ts";
import type { ResultVisibility } from "../../../../shared/contest-types.ts";
/**
 * 统一提交结果投影（F-02/F-15 基础）。
 *
 * 所有读路径（REST 详情/列表、SSE、队列、客观题）强制复用本函数，
 * 确保竞赛中的判据/隐藏用例不会经任何渠道泄露。
 */

/** 投影上下文：viewer 身份 + 竞赛窗口/成员状态。 */
export type ProjectionCtx = {
  /** 查看者 ID（匿名 null） */
  viewerId: string | null;
  /** 是否管理员（full access） */
  isAdmin: boolean;
  /** 是否提交者本人（当前调用方仅传入提交者；题目 owner 未在此投影中特判） */
  isOwner: boolean;
  /** 竞赛上下文；无竞赛为 null */
  contest?: {
    /** 是否竞赛进行中 */
    running: boolean;
    /** 查看者是否为参赛者 */
    participant: boolean;
    type?: ContestType;
    organizer?: boolean;
  } | null;
};

/**
 * 深拷贝并剥离竞赛视角下不可见字段。
 *
 * - admin / 提交者本人 / 无竞赛上下文 → 原样返回；
 * - 竞赛进行中 + 参赛者本人 → 保留 status/score，剥离 details 中的
 *   hidden 用例与 subtasks/testCases（旧脚本无 hidden 标记时 fail-safe 全剥）；
 * - 竞赛赛后 + 参赛者本人 → 保留 status/score，hidden 用例仍不返回；
 * - 竞赛中他人 → 仅返回 { id, problem_id, status } 存在级信息。
 */
export function applySubmissionProjection<
  T extends Record<string, unknown>,
>(
  submission: T,
  ctx: ProjectionCtx,
): T {
  submission = structuredClone(submission);
  const record = submission as Record<string, unknown>;
  for (const target of [record, record.result]) {
    if (!target || typeof target !== "object") continue;
    const item = target as Record<string, unknown>;
    const verdict = oiVerdict(item.details);
    if (verdict) {
      item.verdict = verdict;
      record.verdict = verdict;
      item.output = null;
      item.output_truncated = null;
      const metering = projectMeteringDetails(
        (item.details as Record<string, unknown>).metering,
      );
      if (
        (item.details as Record<string, unknown>).oi &&
        ((item.details as Record<string, unknown>).oi as Record<
            string,
            unknown
          >).backend !== "native"
      ) item.metering = metering;
      item.details = {
        metering,
        oi: projectOiDetails((item.details as Record<string, unknown>).oi),
      };
    }
  }
  // 管理员永远全量。
  if (ctx.isAdmin) {
    return structuredClone(submission);
  }

  // 无竞赛上下文：维持公开提交现状（提交者本人/owner 全量）。
  if (!ctx.contest) {
    return structuredClone(submission);
  }

  if (ctx.contest.organizer) return submission;
  if (
    ctx.contest.running && ctx.contest.type && ctx.contest.type !== "kaggle"
  ) {
    return projectFormatSubmission(submission, ctx);
  }

  const { running, participant } = ctx.contest;
  const isSubmitter = ctx.viewerId !== null &&
    submission.user_id === ctx.viewerId;

  // 题目 owner（非提交者本人）在竞赛内仍全量；提交者本人在赛中/赛后走投影。
  if (ctx.isOwner && !isSubmitter) {
    return structuredClone(submission);
  }

  // 非本人/非参赛者：竞赛内只给存在级信息。
  if (!participant || !isSubmitter) {
    return allowedFields(submission, [
      "id",
      "problem_id",
      "contest_id",
      "status",
    ]) as T;
  }

  const result = structuredClone(submission);
  const projectedRecord = result as Record<string, unknown>;
  delete projectedRecord.progress;
  delete projectedRecord.subtasks;
  delete projectedRecord.testCases;
  delete projectedRecord.output;

  // details：保留 visible 用例，hidden 用例及无标记旧数据全部剥离。
  if (projectedRecord.details !== undefined) {
    const sanitized = sanitizeContestDetails(projectedRecord.details);
    if (sanitized === undefined) {
      delete projectedRecord.details;
    } else {
      projectedRecord.details = sanitized;
    }
  }

  // SubmissionDetail 形态：result 内嵌 details/output 同样需要裁剪。
  if (projectedRecord.result && typeof projectedRecord.result === "object") {
    const nested = projectedRecord.result as Record<string, unknown>;
    delete nested.subtasks;
    delete nested.testCases;
    delete nested.output;
    delete nested.output_truncated;
    if (nested.details !== undefined) {
      const sanitized = sanitizeContestDetails(nested.details);
      if (sanitized === undefined) {
        delete nested.details;
      } else {
        nested.details = sanitized;
      }
    }
  }

  // running/ended 均保留 status/score；赛后不再额外恢复已删除字段。
  void running;
  return result;
}

/** 各赛制本人反馈的字段层级，OI 结束后再开放结果。 */
export function contestResultVisibility(
  type: ContestType,
  running: boolean,
): ResultVisibility {
  if (!running || type === "ioi" || type === "kaggle") return "cases";
  return type === "oi" ? "hidden" : "summary";
}

const SUBMISSION_IDENTITY_FIELDS = [
  "id",
  "public_id",
  "domain_id",
  "problem_id",
  "user_id",
  "contest_id",
  "language",
  "file_name",
  "code",
  "created_at",
  "submitted_version_id",
  "submitted_version",
  "version_origin",
  "upgraded_from_id",
];
const SUMMARY_FIELDS = ["status", "verdict", "score", "time_ms", "memory_kb"];

function allowedFields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(record, key)).map((
      key,
    ) => [key, record[key]]),
  );
}

/** 新赛制采用允许字段列表，不透传原始 output、任意 details 或执行历史。 */
function projectFormatSubmission<T extends Record<string, unknown>>(
  submission: T,
  ctx: ProjectionCtx,
): T {
  const own = ctx.viewerId !== null && submission.user_id === ctx.viewerId;
  if (!own || !ctx.contest?.participant) {
    return allowedFields(submission, ["id", "problem_id"]) as T;
  }
  const visibility = contestResultVisibility(
    ctx.contest.type!,
    ctx.contest.running,
  );
  const result = allowedFields(submission, SUBMISSION_IDENTITY_FIELDS);
  result.result_visibility = visibility;
  if (visibility === "hidden") {
    result.status = "submitted";
    return result as T;
  }
  Object.assign(result, allowedFields(submission, SUMMARY_FIELDS));
  const nested = submission.result;
  if (nested && typeof nested === "object") {
    const summary = allowedFields(nested, SUMMARY_FIELDS);
    const details = (nested as Record<string, unknown>).details;
    const oi = details && typeof details === "object"
      ? (details as Record<string, unknown>).oi
      : null;
    // IOI 严格与 ACM 不返回测试点或子任务；汇总配置也只取明示字段。
    if (visibility === "cases") summary.details = { oi: projectOiDetails(oi) };
    else {
      const oiSummary = allowedFields(oi, [
        "verdict",
        "score",
        "max_score",
        "time_ms",
        "memory_kb",
      ]);
      if (ctx.contest.type === "acm") {
        const diagnostic = oi && typeof oi === "object"
          ? (oi as Record<string, unknown>).compile_error
          : null;
        if (typeof diagnostic === "string") {
          oiSummary.compile_error = diagnostic.slice(0, 16 * 1024);
        }
      }
      summary.details = { oi: oiSummary };
    }
    result.result = summary;
  } else if (submission.details && visibility === "cases") {
    const details = submission.details as Record<string, unknown>;
    result.details = { oi: projectOiDetails(details.oi) };
  }
  return result as T;
}

/**
 * 竞赛视角下的 details 白名单裁剪：
 * - 仅保留带 hidden/visibility 标记的用例数据；
 * - 任何用例缺少标记 → 视为旧脚本，fail-safe 整体剥离；
 * - 保留非 cases 的安全元数据。
 */
function sanitizeContestDetails(details: unknown): unknown {
  if (typeof details !== "object" || details === null) return undefined;
  const obj = details as Record<string, unknown>;
  if (obj.oi) {
    return {
      oi: projectOiDetails(obj.oi),
      metering: projectMeteringDetails(obj.metering),
    };
  }
  if (!Array.isArray(obj.cases)) return undefined;
  const cases = obj.cases;
  if (cases.length === 0) return undefined;

  const isMarked = (c: unknown): boolean =>
    typeof c === "object" && c !== null &&
    ("hidden" in c || "visibility" in c);
  const isHidden = (c: unknown): boolean => {
    if (typeof c !== "object" || c === null) return false;
    const record = c as Record<string, unknown>;
    if (record.hidden === true) return true;
    return record.visibility === "hidden";
  };

  const allMarked = cases.every(isMarked);
  if (!allMarked) return undefined;

  const visibleCases = cases.filter((c) => !isHidden(c));
  return { ...obj, cases: visibleCases };
}
