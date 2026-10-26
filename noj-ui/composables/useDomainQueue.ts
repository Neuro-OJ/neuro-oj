export type QueueScope = 'domain' | 'instance';

export interface QueueItem {
  id: string;
  public_id?: string;
  problem_id: string;
  problem_title: string;
  language: string;
  submitted_at: string;
  submitted_by: string;
  domain_id?: string;
  domain_slug?: string;
  kind: 'submission' | 'self_test';
  resource_pool?: 'oi-wasm' | 'oi-native' | 'ai';
  waiting_reason?: 'pool_full' | 'user_busy' | 'memory';
  judge_started_at?: string | null;
  judge_finished_at?: string | null;
  status?: string;
  score?: number | null;
}

export interface QueuePoolStats {
  pending: number;
  processing: number;
  active?: number;
  compiling?: number;
  running?: number;
  task_capacity?: number;
  run_capacity?: number;
}

export interface QueueStats {
  pending_count: number;
  judging_count: number;
  completed_today: number;
  pools?: Record<string, QueuePoolStats>;
  resource_memory?: { reserved_mb: number; budget_mb: number };
}

export interface QueueData {
  pending: QueueItem[];
  judging: QueueItem[];
  recently_completed: QueueItem[];
  stats: QueueStats;
  scope?: QueueScope;
  visible_counts?: {
    pending: number;
    judging: number;
    completed_today: number;
  };
}

/**
 * 评测队列 API 调用封装。
 * 支持域队列（/api/v1/domains/:slug/queue）与实例队列（/api/v1/instance/queue）。
 * 对应的 SSE 路径末尾为 /events。
 */
export function useDomainQueue() {
  const { api } = useApi();
  return {
    getQueue: (slug: string, scope: QueueScope = 'domain') =>
      scope === 'instance'
        ? api.get<QueueData>('/api/v1/instance/queue', { silent: true })
        : api.get<QueueData>(`/api/v1/domains/${encodeURIComponent(slug)}/queue`, { silent: true }),
    getDomainQueue: (slug: string) =>
      api.get<QueueData>(`/api/v1/domains/${encodeURIComponent(slug)}/queue`, { silent: true }),
    getInstanceQueue: () => api.get<QueueData>('/api/v1/instance/queue', { silent: true }),
    sseUrl: (slug: string, scope: QueueScope = 'domain') =>
      scope === 'instance'
        ? '/api/v1/instance/queue/events'
        : `/api/v1/domains/${encodeURIComponent(slug)}/queue/events`,
  };
}
