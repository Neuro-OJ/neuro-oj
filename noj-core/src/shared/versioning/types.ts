/**
 * 题目版本管理——跨域共享的纯类型与字面量。
 *
 * 本目录只放**纯类型、判定函数与 SQL 谓词**，不得反向依赖任何业务域
 * （Handbook §3.1）。写入服务在各自域内实现，通过门面导出。
 */

/** 有效版本策略的存储字面量。 */
export type EffectiveVersionMode = "any" | "exact";

/**
 * 有效版本策略（Handbook §1.2）。
 *
 * - `{ mode: "any" }`：历史版本均可产生有效成绩（默认）。
 * - `{ mode: "exact", version_id }`：只采用 X 的成绩；X+1 不自动有效。
 *
 * 题库策略与「竞赛 × 题目」策略相互独立。
 */
export type EffectiveVersionPolicy =
  | { mode: "any" }
  | { mode: "exact"; version_id: string };

/** 已发布版本的来源。迁移基线不是历史提交的真实提交时版本。 */
export type ProblemVersionOrigin = "published" | "migration_baseline";

/** 提交的版本来源：`known` 必有提交时版本；`legacy_unknown` 必须为空。 */
export type SubmissionVersionOrigin = "known" | "legacy_unknown";

/** 评测尝试的来源。 */
export type AttemptSource = "initial" | "rejudge" | "upgrade" | "legacy_import";

/** 评测尝试状态机。 */
export type AttemptState =
  | "queued"
  | "judging"
  | "finished"
  | "error"
  | "superseded";

/**
 * 判定类别（Handbook §3.3）。
 *
 * - `graded`：正式判定（含 WA、零分等），可更新当前版本判定。
 * - `platform_error`：平台错误（支持包缺失、容器启动失败、内部异常等），
 *   不替换已有正式判定。
 */
export type AttemptResultKind = "graded" | "platform_error";

/** 批任务类型。 */
export type SubmissionJobKind = "rejudge" | "upgrade";

/** 批任务状态。 */
export type SubmissionJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_errors";

/** 批任务条目状态。 */
export type SubmissionJobItemStatus =
  | "pending"
  | "preparing"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "skipped";

/** 批任务条目引用的源提交种类。 */
export type SubmissionJobSourceKind = "submission" | "objective";

/** 存储对象登记状态（Handbook §2.5）。 */
export type StorageObjectState =
  | "unknown"
  | "ready"
  | "missing"
  | "deleting"
  | "deleted";

/** 题目文件引用角色。 */
export type ProblemObjectRole = "support_package" | "oi_file";

/** 当前正式判定（`submission_version_results` 一行的读模型）。 */
export interface CurrentVersionResult {
  /** 指向 `evaluation_attempts.id`。 */
  attempt_id: string;
  /**
   * 该判定所属题目版本；迁移历史允许为空（未知版本桶）。
   * 空的判定只在 `any` 策略下计入候选。
   */
  problem_version_id: string | null;
  /** ×100 整数，0..10000。 */
  score: number;
  accepted: boolean;
  /** 尝试 sequence，用于同分稳定排序。 */
  sequence: number;
  /** 可选的防御性字段；非 graded / 非终态的候选一律被忽略。 */
  result_kind?: AttemptResultKind | null;
  state?: AttemptState | null;
}

/** 有效成绩选择结果（题库或竞赛其一）。 */
export interface EffectiveSelection {
  is_valid: boolean;
  is_accepted: boolean;
  /** 有效成绩指针：最高分候选；同分按 sequence、ID 升序稳定选择。 */
  effective_attempt_id: string | null;
  /** 通过成绩指针：通过候选中 sequence 最小的记录。 */
  accepted_attempt_id: string | null;
}

/** 空选择：无候选时的唯一表示。 */
export const EMPTY_EFFECTIVE_SELECTION: EffectiveSelection = {
  is_valid: false,
  is_accepted: false,
  effective_attempt_id: null,
  accepted_attempt_id: null,
};

/** 当前无任何有效成绩的提交投影（题库面）。 */
export interface SubmissionEffectiveProjection {
  effective_attempt_id: string | null;
  accepted_attempt_id: string | null;
  is_valid: boolean;
  is_accepted: boolean;
}

/** 当前无任何有效成绩的提交投影（竞赛面）。 */
export interface ContestEffectiveProjection {
  contest_effective_attempt_id: string | null;
  contest_accepted_attempt_id: string | null;
  is_contest_valid: boolean;
  is_contest_accepted: boolean;
}

/** 策略对象 → 数据库列投影（服务端写入前统一转换）。 */
export function policyToColumns(
  policy: EffectiveVersionPolicy,
): {
  effective_version_mode: EffectiveVersionMode;
  required_version_id: string | null;
} {
  return policy.mode === "any"
    ? { effective_version_mode: "any", required_version_id: null }
    : {
      effective_version_mode: "exact",
      required_version_id: policy.version_id,
    };
}

/**
 * 数据库列 → 策略对象。
 *
 * 列形态不合法（`exact` 无要求版本）按 `any` 处理并返回 `null`，由调用方决定
 * 是否升级为错误；读取路径必须宽容，避免一行脏数据让整个列表 500。
 */
export function policyFromColumns(
  mode: string | null | undefined,
  requiredVersionId: string | null | undefined,
): EffectiveVersionPolicy | null {
  if (mode === "exact") {
    return requiredVersionId
      ? { mode: "exact", version_id: requiredVersionId }
      : null;
  }
  if (mode === "any" || mode == null) return { mode: "any" };
  return null;
}
