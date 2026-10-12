/** 来源题号用于展示，使用域由页面 URL 决定。 */
export interface DomainProblemReference {
  problem_id: string;
  source_domain_id: string;
  source_domain_slug: string;
  number: number;
  qualified_ref: string;
  display_ref: string;
  is_shared: boolean;
}
export interface DomainProblemSummary {
  reference: DomainProblemReference;
  title: string;
  kind: 'oi' | 'ai' | 'objective';
  version_id: string;
  version: number;
  binding_id: string;
  policy_revision: number;
}
export interface DomainProblemContent {
  kind: DomainProblemSummary['kind'];
  title: string;
  description: string;
  samples: Array<{ input: string; output: string; explanation?: string }>;
  submission_mode?: 'code' | 'artifact';
  artifact_max_size_mb?: number | null;
  questions?: Array<{
    key: string;
    sort_order: number;
    type: 'single' | 'multiple' | 'judge';
    prompt: string;
    options: Array<{ key: string; text: string }>;
  }>;
}
export interface DomainProblemDetail {
  reference: DomainProblemReference;
  binding_id: string;
  policy_revision: number;
  effective_version_mode: 'any' | 'exact';
  version_id: string;
  version: number;
  can_edit: boolean;
  supported_languages?: string[];
  content: DomainProblemContent;
}
/** 草稿与账号、域、题目、版本及语言一起定位，两个标签页不会改写提交归属。 */
export function domainAnswerKey(actor: string, slug: string, problem: string, version: string, language: string) {
  return JSON.stringify(['domain-answer', actor, slug, problem, version, language]);
}
export function domainProblemApiPath(slug: string, reference?: string) {
  return `/api/v1/domains/${encodeURIComponent(slug)}/problems${reference ? `/${encodeURIComponent(reference)}` : ''}`;
}
