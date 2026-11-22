import {
  getDomainRankingRows,
  PUBLIC_DEFAULT_QUERY_SCOPE,
} from "./domain-query.ts";

/**
 * 用户榜单条目。
 *
 * rank 为 1-based 全局名次，由 SQL 的 ROW_NUMBER() 在排序键上计算，
 * 保证跨分页的一致性（避免第 2 页首行 rank=1 等异常）。
 */
export interface RankingRow {
  rank: number;
  user_id: string;
  username: string;
  avatar_url: string | null;
  solved_count: number;
  total_submissions: number;
  valid_submissions: number;
  /** 0–1 浮点数，保留 3 位小数（与 users.ts:getUserProfileAggregate 一致） */
  acceptance_rate: number;
}

/**
 * 榜单分页响应。
 */
export interface RankingsPage {
  data: RankingRow[];
  total: number;
}

/** 默认域兼容榜单始终采用当前授权事实。 */
export async function getGlobalRankings(
  params: { page: number; limit?: number },
): Promise<RankingsPage> {
  return await getDomainRankingRows(PUBLIC_DEFAULT_QUERY_SCOPE, params);
}

/** 当前用户在默认域公开榜的位置，私有域记录不会提升这个名次。 */
export async function getMyRanking(userId: string): Promise<RankingRow | null> {
  return (await getDomainRankingRows(PUBLIC_DEFAULT_QUERY_SCOPE, {
    page: 1,
    limit: 1,
    userId,
  })).data[0] ?? null;
}
