export const CONTEST_TYPES = ["kaggle"] as const;
export type ContestType = typeof CONTEST_TYPES[number];

export const CONTEST_STATUSES = ["pending", "running", "ended"] as const;
export type ContestStatus = typeof CONTEST_STATUSES[number];

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
  type: ContestType;
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
  type?: ContestType;
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
  type: ContestType;
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
  title: string;
  description: string;
  difficulty: string;
  display_id: string;
  submission_mode: "code" | "artifact";
  artifact_max_size_mb: number | null;
  user_status: ContestProblemUserStatus;
}

export interface KaggleProblemScore {
  label: string;
  best_score: number;
  attempts: number;
  last_best_at: string | null;
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
