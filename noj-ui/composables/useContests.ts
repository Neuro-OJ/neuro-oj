import { formatDateTime } from '~/utils/submissionFormat';

export type ContestType = 'icpc' | 'ioi' | 'oi';
export type ContestStatus = 'pending' | 'running' | 'ended';

export interface ContestConfig {
  penalty_minutes?: number;
  freeze_time?: string | null;
  unfreeze_after_end?: boolean;
  show_ranking_live?: boolean;
}

export interface Contest {
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
  status: ContestStatus;
  problem_count: number;
  participant_count: number;
  is_registered?: boolean;
}

export interface ContestProblem {
  problem_id: string;
  sort_order: number;
  label: string;
  score: number | null;
  title: string;
  description: string;
  difficulty: string;
  display_id: string;
  user_status: 'solved' | 'attempted' | 'untouched';
}

export interface ContestProblemInput {
  problem_id: string;
  sort_order: number;
  label: string;
  score?: number | null;
}

export interface ContestPayload {
  title: string;
  description?: string;
  start_time: string;
  end_time: string;
  type: ContestType;
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

export interface IcpcProblemDetail {
  label: string;
  solved: boolean;
  attempts: number;
  solve_time_minutes?: number | null;
}

export interface IcpcRankingRow {
  rank: number;
  user_id: string;
  username: string;
  avatar_url: string | null;
  solved: number;
  penalty: number;
  problem_details: IcpcProblemDetail[];
}

export interface ScoreProblemDetail {
  label: string;
  best_score: number;
  attempts: number;
}

export interface ScoreRankingRow {
  rank: number;
  user_id: string;
  username: string;
  avatar_url: string | null;
  total_score: number;
  total_time_seconds: number;
  problem_scores: ScoreProblemDetail[];
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

export function useContests() {
  const { api } = useApi();
  const typeLabels: Record<ContestType, string> = {
    icpc: 'ICPC 罚时赛',
    ioi: 'IOI 实时赛',
    oi: 'OI 考试',
  };
  const statusLabels: Record<ContestStatus, string> = {
    pending: '未开始',
    running: '进行中',
    ended: '已结束',
  };

  function formatDuration(startTime: string, endTime: string) {
    const milliseconds = Math.max(0, Date.parse(endTime) - Date.parse(startTime));
    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
    return `${hours > 0 ? `${hours} 小时` : ''}${minutes > 0 ? ` ${minutes} 分钟` : ''}`.trim() || '不足 1 分钟';
  }

  function statusClass(status: ContestStatus) {
    if (status === 'running') return 'bg-green-50 text-success-text border-green-200';
    if (status === 'pending') return 'bg-blue-50 text-info-text border-blue-200';
    return 'bg-gray-100 text-text-secondary border-border';
  }

  // ── 竞赛答疑 API ─────────────────────────────────────────────
  function listClarifications(contestId: string, query?: { page?: number; per_page?: number }) {
    return api.get<{ data: Clarification[]; pagination: Pagination }>(
      `/api/v1/contests/${contestId}/clarifications`,
      { query, silent: true },
    );
  }

  function askClarification(contestId: string, body: { content: string; problem_id?: string }) {
    return api.post<{ data: Clarification }>(`/api/v1/contests/${contestId}/clarifications`, body);
  }

  function replyClarification(contestId: string, clarId: string, body: { content: string; is_public: boolean }) {
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
  };
}
