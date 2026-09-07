import { formatDateTime } from '~/utils/submissionFormat';

export type ContestType = 'kaggle';
export type ContestKind = 'public' | 'invite';
export type ContestStatus = 'pending' | 'running' | 'ended';
export type RankingVisibility = 'public' | 'participants' | 'hidden';

export interface ContestConfig {
  submission_limits?: Record<string, number>;
}

export interface Contest {
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
  kind: ContestKind;
  config: ContestConfig;
  is_public: boolean;
  has_password: boolean;
  affect_global_ranking: boolean;
  created_by: string | null;
  announcement: string;
  status: ContestStatus;
  problem_count: number;
  participant_count: number;
  is_registered?: boolean;
}

export interface ContestProblem {
  problem_id: string;
  sort_order: number;
  label: string;
  score: number;
  title: string;
  description: string;
  difficulty: string;
  display_id: string;
  submission_mode: 'code' | 'artifact';
  artifact_max_size_mb: number | null;
  user_status: 'solved' | 'attempted' | 'untouched';
  /**
   * 是否客观题。注意：后端 ContestProblemResponse 暂未返回该字段
   * （运行时恒为 undefined），保留以便后续后端支持时无需改动调用方。
   */
  is_objective?: boolean;
}

export interface ContestProblemInput {
  problem_id: string;
  sort_order: number;
  label: string;
  score: number;
}

export interface ContestPayload {
  title: string;
  description?: string;
  start_time: string;
  end_time: string;
  ranking_visibility?: RankingVisibility;
  freeze_duration_seconds?: number;
  freeze_start_time?: string | null;
  type: ContestType;
  kind: ContestKind;
  config: ContestConfig;
  is_public: boolean;
  password?: string | null;
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

export interface Pagination {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

export interface ContestAntiCheatAccount {
  user_id: string;
  username: string;
  submission_count: number;
  first_submission_at: string;
  last_submission_at: string;
}

export interface ContestAntiCheatGroup {
  ip: string;
  account_count: number;
  submission_count: number;
  first_submission_at: string;
  last_submission_at: string;
  accounts: ContestAntiCheatAccount[];
}

export interface ContestAntiCheatTimelineItem {
  submission_id: string;
  user_id: string;
  username: string;
  problem_id: string;
  problem_title: string;
  language: string;
  status: string;
  created_at: string;
}

export function useContests() {
  const { api } = useApi();
  const { t, locale } = useI18n();
  const typeLabels = computed<Record<ContestType, string>>(() => ({
    kaggle: t('contest.kaggle'),
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

  // ── 竞赛答疑 API ─────────────────────────────────────────────
  function listClarifications(
    contestId: string,
    query?: { page?: number; per_page?: number },
  ) {
    return api.get<{ data: Clarification[]; pagination: Pagination }>(
      `/api/v1/contests/${contestId}/clarifications`,
      { query, silent: true },
    );
  }

  function listAntiCheatGroups(
    contestId: string,
    query?: { page?: number; per_page?: number; min_accounts?: number },
  ) {
    return api.get<
      {
        data: ContestAntiCheatGroup[];
        pagination: Pagination;
        data_policy: {
          purpose: string;
          retention_days: number;
          automated_penalty: boolean;
        };
      }
    >(
      `/api/v1/admin/contests/${contestId}/anti-cheat/ip-groups`,
      { query, silent: true },
    );
  }

  function listAntiCheatTimeline(contestId: string, ip: string) {
    return api.get<{ data: ContestAntiCheatTimelineItem[] }>(
      `/api/v1/admin/contests/${contestId}/anti-cheat/timeline`,
      { query: { ip }, silent: true },
    );
  }

  function askClarification(
    contestId: string,
    body: { content: string; problem_id?: string },
  ) {
    return api.post<{ data: Clarification }>(
      `/api/v1/contests/${contestId}/clarifications`,
      body,
    );
  }

  function replyClarification(
    contestId: string,
    clarId: string,
    body: { content: string; is_public: boolean },
  ) {
    return api.post<{ data: ClarificationReply }>(
      `/api/v1/contests/${contestId}/clarifications/${clarId}/reply`,
      body,
    );
  }

  return {
    typeLabels,
    statusLabels,
    formatDateTime,
    formatDuration,
    statusClass,
    listClarifications,
    askClarification,
    replyClarification,
    listAntiCheatGroups,
    listAntiCheatTimeline,
  };
}
