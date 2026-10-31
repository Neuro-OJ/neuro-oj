import { computed } from 'vue';
import { formatDateTime } from '~/utils/submissionFormat';
import type { SimilarSubmissionsResponse } from '~/utils/contestAntiCheat';
import type { ContestStatus, ContestType } from '~/utils/contest-types';

/**
 * 管理后台的比赛展示辅助。
 *
 * 0.11 删除了旧无域比赛页面及其组合式运行时代码（答疑、旧榜单组件等）；这里只保留
 * 管理后台 `pages/admin/contests.vue` 仍在使用的四项：类型/状态文案、状态配色，以及
 * 代码相似度查重（人工复核线索）。
 *
 * 类型定义统一在 `utils/contest-types.ts`，本文件不再重复导出。
 */
export function useContestAdminLabels() {
  const { t, locale } = useI18n();
  const typeLabels = computed<Record<ContestType, string>>(() => ({
    kaggle: t('contest.kaggle'),
    oi: 'OI',
    ioi: 'IOI',
    ioi_strict: 'IOI 严格',
    acm: 'ACM/ICPC',
  }));
  const statusLabels = computed<Record<ContestStatus, string>>(() => ({
    pending: t('contest.pending'),
    running: t('contest.running'),
    ended: t('contest.ended'),
  }));

  function formatDuration(startTime: string, endTime: string) {
    const milliseconds = Math.max(
      0,
      Date.parse(endTime) - Date.parse(startTime),
    );
    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
    if (hours === 0 && minutes === 0) {
      return t('contest.durationLessThanMinute');
    }
    if (locale.value === 'en-US') {
      return [hours > 0 ? `${hours}h` : '', minutes > 0 ? `${minutes}m` : '']
        .filter(Boolean).join(' ');
    }
    return `${hours > 0 ? `${hours} 小时` : ''}${minutes > 0 ? ` ${minutes} 分钟` : ''}`.trim();
  }

  function statusClass(status: ContestStatus) {
    if (status === 'running') {
      return 'bg-green-50 text-success-text border-green-200';
    }
    if (status === 'pending') {
      return 'bg-blue-50 text-info-text border-blue-200';
    }
    return 'bg-gray-100 text-text-secondary border-border';
  }

  /**
   * 竞赛内互相高度相似的提交对（人工复核线索）。
   *
   * 基于 IP 碰撞的作弊判定（`anti-cheat/ip-groups`、`anti-cheat/timeline`）已全面下线
   * （VULN-06：机房 NAT 多 IP 共用误伤过高），只保留代码相似度查重。响应**不含源
   * 代码**；源码走 `/api/v1/admin/submission/submissions/:id`。
   */
  function listAntiCheatSimilarSubmissions(
    contestId: string,
    query?: { threshold?: number; limit?: number; problem_id?: string },
  ) {
    const { api } = useApi();
    return api.get<SimilarSubmissionsResponse>(
      `/api/v1/admin/contest/contests/${contestId}/anti-cheat/similar-submissions`,
      { query, silent: true },
    );
  }

  return {
    typeLabels,
    statusLabels,
    formatDateTime,
    formatDuration,
    statusClass,
    listAntiCheatSimilarSubmissions,
  };
}
