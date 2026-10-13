export type DomainJobSource = { kind: 'submission' | 'objective'; id: string };
export type DomainJobScope = { type: 'selected'; submissions: DomainJobSource[] } | {
  type: 'problem';
  problem_id: string;
} | { type: 'contest'; contest_id: string };
export type DomainJobTarget = { mode: 'submitted' } | { mode: 'latest' } | {
  mode: 'specified';
  versions: Record<string, string>;
};
export type DomainSubmissionJobRequest =
  | { kind: 'upgrade'; submissions: DomainJobSource[]; context: 'practice' | 'source_contest' }
  | {
    kind: 'rejudge';
    scope: DomainJobScope;
    target: DomainJobTarget;
    policy_changes: {
      problem_id: string;
      contest_id?: string;
      expected_revision: number;
      policy: { mode: 'any' } | { mode: 'exact'; version_id: string };
      reason: string;
    }[];
  };
export interface DomainSubmissionJobReceipt {
  job_id: string;
  status: string;
  total_items: number;
  skipped_items?: number;
  existing: boolean;
}
export interface DomainSubmissionJob {
  id: string;
  domain_id: string;
  kind: string;
  actor_id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  total_items: number;
  counts: Record<string, number>;
  cancel_requested: boolean;
}
export interface DomainSubmissionJobItem {
  id: string;
  ordinal: number;
  source_kind: 'submission' | 'objective';
  source_id: string;
  problem_id: string;
  target_version_id: string | null;
  target_version_ref: string | null;
  status: string;
  attempt_id: string | null;
  reason_code: string | null;
  reason_message: string | null;
  result_submission_id: string | null;
  domain_id: string | null;
  domain_problem_binding_id: string | null;
}
export const DOMAIN_JOB_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  completed_with_errors: '已完成，含失败条目',
  pending: '待处理',
  preparing: '准备中',
  dispatched: '已派发',
  succeeded: '已评测',
  failed: '失败',
  skipped: '已跳过',
};
export function domainJobTerminal(status: string) {
  return status === 'completed' || status === 'completed_with_errors';
}
