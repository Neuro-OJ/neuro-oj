export const CONTEST_TYPES = ["kaggle"] as const;
export type ContestType = typeof CONTEST_TYPES[number];

export const CONTEST_KINDS = ["public", "invite"] as const;
export type ContestKind = typeof CONTEST_KINDS[number];

export const CONTEST_STATUSES = ["pending", "running", "ended"] as const;
export type ContestStatus = typeof CONTEST_STATUSES[number];

export const RANKING_VISIBILITIES = [
  "public",
  "participants",
  "hidden",
] as const;
export type RankingVisibility = typeof RANKING_VISIBILITIES[number];

/**
 * 类 Kaggle 赛制配置。
 * `submission_limits` 为可选字段：`{ "<problem_id>": <number> }`，
 * 表示该题在比赛内最多允许的提交次数；未配置的题目不限制。
 */
export interface KaggleContestConfig {
  submission_limits?: Record<string, number>;
}

export type ContestConfig = KaggleContestConfig;

export function isValidContestType(value: string): value is ContestType {
  return CONTEST_TYPES.includes(value as ContestType);
}

export function isValidRankingVisibility(
  value: string,
): value is RankingVisibility {
  return RANKING_VISIBILITIES.includes(value as RankingVisibility);
}

export function isValidContestKind(value: string): value is ContestKind {
  return CONTEST_KINDS.includes(value as ContestKind);
}

export function isValidContestConfig(
  _type: ContestType,
  config: unknown,
): config is ContestConfig {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return false;
  }

  const values = config as Record<string, unknown>;
  if (values.submission_limits !== undefined) {
    if (
      typeof values.submission_limits !== "object" ||
      values.submission_limits === null ||
      Array.isArray(values.submission_limits)
    ) {
      return false;
    }
    for (
      const v of Object.values(
        values.submission_limits as Record<string, unknown>,
      )
    ) {
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        return false;
      }
    }
  }
  return true;
}

export interface ContestProblemInput {
  problem_id: string;
  sort_order: number;
  label: string;
  /** 每题满分 ×100，必填 */
  score: number;
}

export interface CreateContestInput {
  title: string;
  description?: string;
  start_time: string;
  end_time: string;
  ranking_visibility?: RankingVisibility;
  freeze_start_time?: string | null;
  freeze_duration_seconds?: number;
  type: ContestType;
  /** 竞赛分类：public=公开赛（仅管理员）/ invite=邀请赛（需邀请码） */
  kind?: ContestKind;
  config?: ContestConfig;
  is_public?: boolean;
  password?: string | null;
  affect_global_ranking?: boolean;
  announcement?: string;
  problems: ContestProblemInput[];
}

export interface UpdateContestInput {
  title?: string;
  description?: string;
  start_time?: string;
  end_time?: string;
  ranking_visibility?: RankingVisibility;
  freeze_start_time?: string | null;
  freeze_duration_seconds?: number;
  type?: ContestType;
  kind?: ContestKind;
  config?: ContestConfig;
  is_public?: boolean;
  password?: string | null;
  affect_global_ranking?: boolean;
  announcement?: string;
  problems?: ContestProblemInput[];
}

export interface ContestResponse {
  id: string;
  public_id: string;
  title: string;
  description: string;
  start_time: string;
  end_time: string;
  ranking_visibility: RankingVisibility;
  freeze_start_time: string | null;
  freeze_duration_seconds: number;
  type: ContestType;
  kind: ContestKind;
  config: ContestConfig;
  is_public: boolean;
  has_password: boolean;
  affect_global_ranking: boolean;
  created_by: string | null;
  announcement: string;
  created_at: string;
  updated_at: string;
  status: ContestStatus;
  problem_count: number;
  participant_count: number;
  is_registered?: boolean;
}

export type ContestProblemUserStatus = "solved" | "attempted" | "untouched";

export interface ContestProblemResponse extends ContestProblemInput {
  judge_type?: "dual" | "oi";
  is_objective?: boolean;
  judge_backend?: "dual" | "oi-native" | "oi-wasm" | null;
  supported_languages?: string[];
  title: string;
  description: string;
  difficulty: string;
  display_id: string;
  submission_mode: "code" | "artifact";
  artifact_max_size_mb: number | null;
  /**
   * 题目可见性（public / private）。
   *
   * 审计 VULN-04/VULN-05：邀请赛若挂载**全站公开题**，平台不会对其做全站保密遮蔽
   * （防普通用户借邀请赛劫持公共题库的 anti-DoS 设计），因此出题人必须在选题时
   * 被告知"要保密请用自己名下的私有题"。前端据此提示，故需真实下发的 visibility。
   */
  visibility: "public" | "private";
  user_status: ContestProblemUserStatus;
  /**
   * 竞赛固定的作答版本（Handbook §2.6/§4.2）。
   *
   * 竞赛提交只接受该版本：客户端必须原样回传，服务端不一致时返回
   * `409 CONTEST_PROBLEM_VERSION_CHANGED`（保留已写内容、提示刷新），绝不自动换版。
   * 迁移期尚未固定的存量竞赛为 null。
   */
  version_id: string | null;
  /** 固定版本的版本号（展示用；无固定版本为 null）。 */
  version: number | null;
  /**
   * 该「竞赛 × 题目」的有效版本策略（与题库策略独立，Handbook §1.2）。
   *
   * `exact(X)` 时要求版本必然等于固定作答版本；管理端切换策略时按此项回显。
   */
  effective_version_policy?:
    | { mode: "any" }
    | { mode: "exact"; version_id: string | null };
  /** 策略乐观锁版本（管理端切换策略/升级固定版本时必须回传）。 */
  effective_version_policy_revision?: number;
}

export interface KaggleProblemScore {
  label: string;
  best_score: number;
  attempts: number;
  last_best_at: string | null;
  submission_id?: string | null;
  rejudge_seq?: number | null;
  evaluation_status?: string | null;
  evaluation_created_at?: string | null;
  /**
   * 正式成绩归因（Handbook §3.4/§6.6）：最佳成绩所属提交的**竞赛口径有效尝试**。
   *
   * 快照据此把成绩固定到具体一次执行；后续重测只改实时榜，不自动改写已发布快照。
   */
  effective_attempt_id?: string | null;
  /** 该最佳成绩所属提交的提交时版本（迁移期未知版本为 null）。 */
  submitted_version_id?: string | null;
  /** 该「竞赛 × 题目」当时的固定作答版本。 */
  pinned_version_id?: string | null;
  /** 该「竞赛 × 题目」当时的有效版本策略。 */
  version_policy?: { mode: "any" } | {
    mode: "exact";
    version_id: string | null;
  };
  /** 该「竞赛 × 题目」策略的乐观锁版本（快照归因用）。 */
  policy_revision?: number | null;
}

export interface KaggleRankingRow {
  rank: number;
  user_id: string;
  username: string;
  avatar_url: string | null;
  total_score: number;
  last_submission_at: string | null;
  problem_scores: KaggleProblemScore[];
}
