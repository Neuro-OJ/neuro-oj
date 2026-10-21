/** 受当前使用域授权的题目展示摘要，不包含题面或私有评测配置。 */
export interface ProblemSummary {
  reference: string;
  availability: 'available' | 'unavailable';
  title: string | null;
  kind: 'oi' | 'ai' | 'objective' | null;
  answer_version_id: string | null;
  answer_version: number | null;
  progress: 'solved' | 'attempted' | 'unseen' | null;
}
export interface ProblemSummaries {
  items: ProblemSummary[];
}
