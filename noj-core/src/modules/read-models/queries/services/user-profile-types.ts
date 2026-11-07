/**
 * 用户主页聚合的类型定义。
 *
 * 拆自 services/users.ts，供 users-profile-query.ts（查询）与
 * users-profile.ts（聚合）共用。
 */

/**
 * 用户主页响应——聚合统计、已通过题目、最近提交。
 */
export interface UserProfileResponse {
  user: {
    id: string;
    username: string;
    bio: string;
    avatar_url: string | null;
    created_at: string;
  };
  stats: {
    total_submissions: number;
    valid_submissions: number;
    accepted: number;
    acceptance_rate: number;
    solved_count: number;
  };
  solved_problems: {
    id: string;
    title: string;
    difficulty: string;
    accepted_at: string;
  }[];
  recent_submissions: {
    id: string;
    problem_id: string;
    problem_title: string;
    language: string;
    status: string;
    result_status: string | null;
    score: number | null;
    created_at: string;
  }[];
  community_stats: {
    solution_count: number;
  };
  /** 该用户创建的题目（跨域、按查看者可见性过滤；审计 F5）。 */
  created_problems: {
    id: string;
    /** `{domain_slug}:{number}`，前端据此生成域路由链接。 */
    display_id: string;
    title: string;
    difficulty: string;
    created_at: string;
  }[];
  solutions: { id: string; title: string; created_at: string }[];
}

/** 用户基础信息行（users 表子集）。 */
export interface ProfileUserRow {
  id: string;
  username: string;
  bio: string;
  avatar_url: string | null;
  created_at: string;
}

/** 提交统计聚合行。 */
export interface ProfileStatsRow {
  total_submissions: number;
  valid_submissions: number;
  accepted: number;
  solved_count: number;
}

/** 已通过题目行。 */
export interface ProfileSolvedProblemRow {
  problem_id: string;
  problem_title: string;
  difficulty: string;
  accepted_at: string;
  /** 是否被尚未结束的公开赛收编（仅特权查看者会看到 true 的行，见 users-profile-queries） */
  is_contest_hidden?: boolean;
}

/** 最近提交行（不含 code 字段）。 */
export interface ProfileRecentSubmissionRow {
  id: string;
  problem_id: string;
  problem_title: string | null;
  language: string;
  status: string;
  result_status: string | null;
  result_score: number | null;
  created_at: string;
}

/** 社区关注/内容统计行。 */
export interface ProfileCommunityStatsRow {
  solution_count: number;
}

/** 已发布题解行。 */
export interface ProfileSolutionRow {
  id: string;
  title: string | null;
  created_at: string;
}

/** 「创建的题目」行（含域 slug 与题号，用于拼 display_id）。 */
export interface ProfileCreatedProblemRow {
  id: string;
  title: string;
  difficulty: string;
  created_at: string;
  number: number;
  domain_slug: string;
  display_id?: string;
}

/** 「创建的题目」视图行（已拼好 display_id，直接下发）。 */
export interface ProfileCreatedProblemView {
  id: string;
  display_id: string;
  title: string;
  difficulty: string;
  created_at: string;
}
