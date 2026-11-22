/**
 * 用户榜单相关类型与 composable。
 * 与后端 services/rankings.ts 响应字段对齐。
 */

export interface RankingRow {
  /** 1-based 全局名次 */
  rank: number;
  user_id: string;
  username: string;
  avatar_url: string | null;
  /** 独立通过的题目数 */
  solved_count: number;
  /** 总提交数 */
  total_submissions: number;
  /** 0–1 浮点数 */
  acceptance_rate: number;
}

export interface RankingsPagination {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

export interface RankingsResponse {
  data: RankingRow[];
  pagination: RankingsPagination;
}

/**
 * 获取全站榜单。
 * @param page 页码（从 1 开始）
 * @param limit 每页条数（默认 50，最大 100）
 */
export function useRankings(page: Ref<number>, limit: number = 50) {
  return useFetch<RankingsResponse>(() => {
    const qs = new URLSearchParams({
      page: String(page.value),
      limit: String(limit),
    });
    return `/api/v1/rankings?${qs.toString()}`;
  });
}

/** 签到活跃榜行（issue #184 / #580），与后端 getCheckinLeaderboard 对齐。 */
export interface CheckinRankingRow {
  /** 1-based 名次（签到天数倒序 + 用户名升序） */
  rank: number;
  user_id: string;
  username: string;
  /** 当月签到天数 */
  days: number;
}

export interface CheckinRankingsResponse {
  data: CheckinRankingRow[];
  pagination: RankingsPagination;
  /** 登录用户当月名次；未登录或当月未签到为 null */
  user_rank: number | null;
}

/**
 * 获取签到活跃榜。
 * @param month `YYYY-MM`（UTC）
 * @param page 页码（从 1 开始）
 * @param perPage 每页条数（最大 100）
 */
export function useCheckinRankings(
  month: Ref<string>,
  page: Ref<number>,
  perPage: number = 50,
) {
  return useFetch<CheckinRankingsResponse>(() => {
    const qs = new URLSearchParams({
      month: month.value,
      page: String(page.value),
      per_page: String(perPage),
    });
    return `/api/v1/rankings/checkin?${qs.toString()}`;
  });
}
