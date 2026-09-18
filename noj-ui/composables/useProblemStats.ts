import type { ProblemStatsDetail, PublicProblemStats } from '~/utils/problemStats';

/**
 * 题目统计获取。
 *
 * 契约与展示辅助在 `~/utils/problemStats`（纯逻辑，可被 deno test 断言）；
 * 本 composable 只负责 API 调用。
 */
export function useProblemStats() {
  const { api } = useApi();

  /** 公开统计：通过率对所有人可见，赛中由后端抑制。 */
  function fetchPublic(problemId: string) {
    return api.get<{ data: PublicProblemStats }>(
      `/api/v1/problems/${problemId}/stats/public`,
      { silent: true },
    );
  }

  /** 深度统计：仅题目 owner 与管理员可读，非授权返回 403。 */
  function fetchDetail(problemId: string, windowDays = 90) {
    return api.get<{ data: ProblemStatsDetail }>(
      `/api/v1/problems/${problemId}/stats`,
      { query: { window_days: windowDays }, silent: true },
    );
  }

  return { fetchPublic, fetchDetail };
}
