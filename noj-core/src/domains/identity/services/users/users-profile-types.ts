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
    following_count: number;
    follower_count: number;
    solution_count: number;
    moment_count: number;
  };
  solutions: { id: string; title: string; created_at: string }[];
  moments: { id: string; content: string; created_at: string }[];
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
  accepted: number;
  solved_count: number;
}

/** 已通过题目行。 */
export interface ProfileSolvedProblemRow {
  problem_id: string;
  problem_title: string;
  difficulty: string;
  accepted_at: string;
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
  following_count: number;
  follower_count: number;
  solution_count: number;
  moment_count: number;
}

/** 已发布题解行。 */
export interface ProfileSolutionRow {
  id: string;
  title: string | null;
  created_at: string;
}

/** 已发布短动态行。 */
export interface ProfileMomentRow {
  id: string;
  content: string;
  created_at: string;
}
