/**
 * 比赛相关的**纯类型**与展示常量。
 *
 * 历史：这些类型原先和 `useContests()` 运行时代码放在同一个文件里。0.11 删除了旧
 * 无域比赛页面（其运行时代码唯一消费者），但域页面、管理后台与编辑器仍需要这些
 * 类型。因此把类型拆出来，运行时部分只保留管理后台还在用的展示辅助。
 *
 * 注意：`kind` / `is_public` / `has_password` / `password` 已从后端响应与输入中移除
 * （见 CHANGELOG「兼容清理」）。这里保留字段名仅用于**旧数据读取兼容**，新代码不要
 * 再写入或依赖它们。
 */

export type ContestType = 'kaggle' | 'oi' | 'ioi' | 'ioi_strict' | 'acm';
/** 已废弃：比赛不再区分公开赛/邀请赛。仅历史数据可能仍带该值。 */
export type ContestKind = 'public' | 'invite';
export type ContestStatus = 'pending' | 'running' | 'ended';
export type RankingVisibility = 'public' | 'participants' | 'hidden';

export interface ContestConfig {
  submission_limits?: Record<string, number>;
  penalty_minutes?: number;
  scoreboard_scope?: 'self' | 'full';
}

export interface Contest {
  secrecy_enabled: boolean;
  id: string;
  public_id?: string;
  title: string;
  description: string;
  start_time: string;
  end_time: string;
  ranking_visibility: RankingVisibility;
  freeze_start_time: string | null;
  freeze_duration_seconds: number;
  type: ContestType;
  config: ContestConfig;
  affect_global_ranking: boolean;
  created_by: string | null;
  announcement: string;
  status: ContestStatus;
  problem_count: number;
  participant_count: number;
  updated_at: string;
  is_registered?: boolean;
  domain_id?: string;
  revision?: number;
  /** @deprecated 后端已不再下发；仅历史响应兼容。 */
  kind?: ContestKind;
  /** @deprecated 后端已不再下发；仅历史响应兼容。 */
  is_public?: boolean;
  /** @deprecated 后端已不再下发；仅历史响应兼容。 */
  has_password?: boolean;
}

export interface ContestProblem {
  samples?: import('~/utils/oiWorkspace').ProblemSample[];
  limits?: { time_limit_ms: number; memory_limit_mb: number } | null;
  reference?: import('~/utils/domain-problems').DomainProblemReference;
  judge_type?: 'dual' | 'oi';
  supported_languages?: string[];
  problem_id: string;
  sort_order: number;
  label: string;
  score: number;
  title: string;
  description: string;
  difficulty: string;
  display_id: string;
  submission_mode: 'code' | 'artifact' | 'prediction' | 'ui';
  artifact_max_size_mb: number | null;
  user_status: 'solved' | 'attempted' | 'untouched';
  /**
   * 是否客观题。注意：后端 `ContestProblemResponse` 暂未返回该字段
   * （运行时恒为 undefined），保留以便后续后端支持时无需改动调用方。
   */
  is_objective?: boolean;
  /**
   * 竞赛固定作答版本（Handbook §4.1/§4.2）。
   *
   * 提交必须原样回传；与固定版本不一致 → 409 `CONTEST_PROBLEM_VERSION_CHANGED`。
   * 迁移期尚未固定版本的竞赛题目为 null（此时按存量路径作答）。
   */
  version_id?: string | null;
  /** 固定版本的版本号（展示用）。 */
  version?: number | null;
  /** 该「竞赛 × 题目」的有效版本策略（与题库策略独立）。 */
  effective_version_policy?:
    | { mode: 'any' }
    | { mode: 'exact'; version_id: string | null };
  /** 策略乐观锁版本（管理端切换策略/升级固定版本时必须回传）。 */
  effective_version_policy_revision?: number;
}

export interface ContestProblemInput {
  problem_id: string;
  sort_order: number;
  label: string;
  score: number;
}

/** 创建/更新比赛的请求体。旧分类与密码字段已移除（后端会以 400 拒绝）。 */
export interface ContestPayload {
  secrecy_enabled?: boolean;
  classroom_ids?: string[];
  title: string;
  description?: string;
  start_time: string;
  end_time: string;
  ranking_visibility?: RankingVisibility;
  freeze_duration_seconds?: number;
  freeze_start_time?: string | null;
  type: ContestType;
  config: ContestConfig;
  affect_global_ranking: boolean;
  announcement?: string;
  problems: ContestProblemInput[];
}

export interface AdminContestDetail extends Contest {
  problems: ContestProblem[];
}

export interface AdminProblemOption {
  id: string;
  display_id: string;
  title: string;
  difficulty: string;
  /**
   * 题目可见性（`GET /api/v1/admin/catalog/problems` 返回）。旧后端未返回时为
   * undefined，调用方按"未知"处理。
   */
  visibility?: 'public' | 'private';
}

export interface KaggleProblemScore {
  label: string;
  best_score: number | null;
  pending?: boolean;
  accepted?: boolean;
  penalty_ms?: number;
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
  solved?: number;
  penalty_ms?: number;
  pending?: boolean;
}

export interface Pagination {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

/** 竞赛答疑的参与者身份（与题库用户身份同构，仅取展示字段）。 */
export interface ClarificationSender {
  id: string;
  username: string;
  avatar_url: string | null;
}

export interface ClarificationReply {
  id: string;
  content: string;
  is_public: boolean;
  created_at: string;
  sender: ClarificationSender;
}

export interface Clarification {
  id: string;
  contest_id: string;
  problem_id: string | null;
  problem_label: string | null;
  content: string;
  is_public: boolean;
  created_at: string;
  sender: ClarificationSender;
  replies: ClarificationReply[];
}
