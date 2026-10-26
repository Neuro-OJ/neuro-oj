/** 教学读取只包含原提交及授权汇总，不携带评测数据或标准答案。 */
export interface TeachingSubmission {
  id: string;
  kind: 'submission' | 'objective';
  domain_id: string;
  user_id: string;
  problem_id: string;
  binding_id: string | null;
  source_slug: string;
  source_domain_id: string;
  number: number;
  display_ref: string;
  contest_id: string | null;
  created_at: string;
  submitted_version_id: string | null;
  language: string | null;
  status: string;
  score: number | null;
  accepted: boolean;
  file_name: string | null;
  has_artifact: boolean;
  verdict: string | null;
  time_ms: number | null;
  memory_kb: number | null;
  code?: string | null;
  answers?: Record<string, Array<string | boolean>> | null;
}
/** 没有有效正式分数不推断失败或零分，正式通过仍依据 accepted。 */
export function teachingSubmissionResult(row: TeachingSubmission) {
  if (row.score === null) return ['pending', 'judging'].includes(row.status) ? '评测中' : '暂无有效成绩';
  const score = `${row.score / 100} 分`;
  return row.accepted ? `已通过 · ${score}` : row.verdict ? `${row.verdict} · ${score}` : score;
}

export interface TeachingOiCase {
  id?: string;
  case_id?: string;
  verdict?: string;
  status?: string;
  score?: number;
  max_score?: number;
  time_ms?: number;
  memory_kb?: number;
}
export interface TeachingAttempt {
  id: string;
  sequence: number;
  source: string;
  state: string;
  result_kind: string | null;
  problem_version_id: string | null;
  created_at: string;
  finished_at: string | null;
  score: number | null;
  accepted: boolean;
  verdict: string | null;
  current_formal: boolean;
  matches_policy: boolean;
  oi: null | {
    subtasks?: Array<
      { id: string; verdict?: string; status?: string; score?: number; max_score?: number; cases?: TeachingOiCase[] }
    >;
    cases?: TeachingOiCase[];
  };
}
export interface AssignmentSubmissionEvidence {
  page: number;
  per_page: number;
  total: number;
  scope: 'on_time' | 'current';
  policy: { mode: 'any' | 'exact'; required_version_id: string | null; revision: number; resource_available: boolean };
  data: Array<TeachingSubmission & { candidate_attempt_ids: string[] }>;
}
/** 平台失败不变成正式零分；旧判定与当前候选分别说明。 */
export function teachingAttemptLabel(attempt: TeachingAttempt) {
  if (attempt.result_kind === 'platform_error') return '平台评测失败 · 待处理';
  if (attempt.score === null) return ['queued', 'judging'].includes(attempt.state) ? '评测中' : '暂无正式成绩';
  return `${attempt.verdict ? `${attempt.verdict} · ` : ''}${attempt.score / 100} 分${
    attempt.accepted ? ' · 已通过' : ''
  }`;
}
