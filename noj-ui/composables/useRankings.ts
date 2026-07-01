/**
 * 用户榜单相关类型与 composable。
 * 与后端 services/rankings.ts 响应字段对齐。
 */

export interface RankingRow {
  /** 1-based 全局名次 */
  rank: number
  user_id: string
  username: string
  /** 独立通过的题目数 */
  solved_count: number
  /** 总提交数 */
  total_submissions: number
  /** 0–1 浮点数 */
  acceptance_rate: number
}

export interface RankingsPagination {
  page: number
  per_page: number
  total: number
  total_pages: number
}

export interface RankingsResponse {
  data: RankingRow[]
  pagination: RankingsPagination
}

export interface MyRankingResponse {
  data: RankingRow | null
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
    })
    return `/api/v1/rankings?${qs.toString()}`
  })
}

/**
 * 获取当前登录用户的榜单条目。
 * 未登录或未上榜时返回 null。
 */
export async function fetchMyRanking(): Promise<RankingRow | null> {
  const res = await $fetch<MyRankingResponse>("/api/v1/rankings/me")
  return res.data
}

/**
 * 格式化通过率（0–1 → "xx.x%"）。
 */
export function formatAcceptanceRate(rate: number | null | undefined): string {
  if (rate == null) return "--"
  return `${(rate * 100).toFixed(1)}%`
}