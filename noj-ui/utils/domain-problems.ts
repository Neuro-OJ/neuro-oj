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
  difficulty?: string;
  judge_backend?: 'dual' | 'oi-native' | 'oi-wasm' | null;
  limits?: { time_limit_ms: number | null; memory_limit_mb: number | null } | null;
  tags?: Array<{ id: string; name: string; kind: string }>;
  has_hidden_algorithm_tags?: boolean;
  progress?: 'solved' | 'attempted' | 'unseen' | null;
  submit_count?: number;
  best_score?: number | null;
  valid_submissions?: number;
  accepted_submissions?: number;
}
export interface DomainProblemContent {
  kind: DomainProblemSummary['kind'];
  title: string;
  description: string;
  samples: Array<{ input: string; output: string; explanation?: string }>;
  submission_mode?: 'code' | 'artifact' | 'prediction' | 'ui';
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
  answer_version_id: string;
  required_version_id: string | null;
  version_id: string;
  version: number;
  can_edit: boolean;
  supported_languages?: string[];
  difficulty?: string;
  statistics?: {
    submit_count: number;
    valid_submissions: number;
    accepted_submissions: number;
    progress: 'solved' | 'attempted' | 'unseen' | null;
  };
  judge_backend?: DomainProblemSummary['judge_backend'];
  owner?: { id: string; username: string; avatar_url: string | null } | null;
  tags?: Array<{ id: string; name: string; kind: 'problem' | 'algorithm' }>;
  has_hidden_algorithm_tags?: boolean;
  limits?: { time_limit_ms: number; memory_limit_mb: number } | null;
  content: DomainProblemContent;
}
/** 独立代码工作区只消费公开题面、版本与执行语言，不接收作者配置。 */
export type DomainCodeProblem = Pick<
  DomainProblemDetail,
  'reference' | 'version_id' | 'version' | 'supported_languages' | 'difficulty' | 'limits' | 'content'
>;
/** 草稿与账号、域、题目、版本及语言一起定位，两个标签页不会改写提交归属。 */
export function domainAnswerKey(actor: string, slug: string, problem: string, version: string, language: string) {
  return JSON.stringify(['domain-answer', actor, slug, problem, version, language]);
}
export function domainProblemApiPath(slug: string, reference?: string) {
  return `/api/v1/domains/${encodeURIComponent(slug)}/problems${reference ? `/${encodeURIComponent(reference)}` : ''}`;
}
