import type { DomainProblemReference } from './domain-problems.ts';
import { workspaceProblemPath } from './workspace.ts';
import type { AssignmentSubmissionOrigin } from './education.ts';
export type OwnSubmissionKind = 'submission' | 'objective';
/** 本人目录可读取失去域权限后的原提交；不包含题面或评测数据。 */
export interface OwnSubmissionHistory {
  kind: OwnSubmissionKind;
  id: string;
  public_id: string;
  user_id?: string;
  username?: string;
  can_view_answers?: boolean;
  can_view_source?: boolean;
  domain: { id: string; slug: string; name: string; accessible: boolean };
  problem: { id: string; title: string };
  reference: DomainProblemReference;
  resource_available: boolean;
  contest_id: string | null;
  assignment_origin?: AssignmentSubmissionOrigin | null;
  language: string;
  file_name: string | null;
  has_artifact: boolean;
  created_at: string;
  submitted_version_id: string | null;
  submitted_version?: number | null;
  status: string;
  result_visibility: 'hidden' | 'summary' | 'cases';
  is_valid?: boolean;
  is_accepted?: boolean;
  result?: {
    status: string | null;
    score: number | null;
    verdict: string | null;
    time_ms: number | null;
    memory_kb: number | null;
  } | null;
  code?: string | null;
  answers?: Record<string, unknown> | null;
}
/** 返回题目必须同时仍可进入使用域并拥有当前资源授权。 */
export function ownHistoryProblemLink(entry: OwnSubmissionHistory) {
  return entry.domain.accessible && entry.resource_available
    ? workspaceProblemPath(entry.domain.slug, entry.reference.display_ref)
    : undefined;
}
/** 统一账号历史页面不依赖当前域，两个提交类型保留各自身份。 */
export function ownHistoryDetailLink(entry: Pick<OwnSubmissionHistory, 'kind' | 'id'>) {
  return `/my/submissions/${entry.kind}/${encodeURIComponent(entry.id)}`;
}
/** 原回答是用户选择，不将判断题布尔值显示成评测正确性。 */
export function originalAnswerText(answer: unknown): string {
  if (Array.isArray(answer)) return answer.map(originalAnswerText).join('、') || '未作答';
  if (typeof answer === 'boolean') return answer ? '选择“对”' : '选择“错”';
  if (typeof answer === 'string' || typeof answer === 'number') return String(answer);
  return answer == null ? '未作答' : '此回答格式无法直接预览';
}
