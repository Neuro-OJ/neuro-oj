export const CONTEST_TYPES = ["icpc", "ioi", "oi"] as const;
export type ContestType = typeof CONTEST_TYPES[number];

export const CONTEST_STATUSES = ["pending", "running", "ended"] as const;
export type ContestStatus = typeof CONTEST_STATUSES[number];

export interface IcpcContestConfig {
  penalty_minutes?: number;
  freeze_time?: string | null;
  unfreeze_after_end?: boolean;
}

export interface ScoreContestConfig {
  show_ranking_live?: boolean;
}

export type ContestConfig = IcpcContestConfig | ScoreContestConfig;

export function isValidContestType(value: string): value is ContestType {
  return CONTEST_TYPES.includes(value as ContestType);
}

export function isValidContestConfig(
  type: ContestType,
  config: unknown,
): config is ContestConfig {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return false;
  }

  const values = config as Record<string, unknown>;
  if (type === "icpc") {
    return (
      (values.penalty_minutes === undefined ||
        (Number.isInteger(values.penalty_minutes) &&
          Number(values.penalty_minutes) > 0)) &&
      (values.freeze_time === undefined || values.freeze_time === null ||
        (typeof values.freeze_time === "string" &&
          !Number.isNaN(Date.parse(values.freeze_time)))) &&
      (values.unfreeze_after_end === undefined ||
        typeof values.unfreeze_after_end === "boolean")
    );
  }

  return values.show_ranking_live === undefined ||
    typeof values.show_ranking_live === "boolean";
}

export interface ContestProblemInput {
  problem_id: string;
  sort_order: number;
  label: string;
  score?: number | null;
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
  user_status: ContestProblemUserStatus;
}

export interface IcpcProblemDetail {
  label: string;
  solved: boolean;
  attempts: number;
  solve_time_minutes?: number;
}

export interface IcpcRankingRow {
  rank: number;
  user_id: string;
  username: string;
  avatar_url: string | null;
  solved: number;
  penalty: number;
  last_ac_time: string | null;
  problem_details: IcpcProblemDetail[];
}

export interface IoiProblemScore {
  label: string;
  best_score: number;
  attempts: number;
}

export interface IoiRankingRow {
  rank: number;
  user_id: string;
  username: string;
  avatar_url: string | null;
  total_score: number;
  total_time_seconds: number;
  problem_scores: IoiProblemScore[];
}
