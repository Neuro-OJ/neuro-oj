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
