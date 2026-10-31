/** 受当前使用域授权的题目展示摘要，不包含题面或私有评测配置。 */
export interface ProblemSummary {
  contest_protection?: Array<{ contestId: string; publicId: string; title: string }>;
  can_read?: boolean;
  can_practice?: boolean;
  reference: string;
  availability: 'available' | 'unavailable';
  title: string | null;
  kind: 'oi' | 'ai' | 'objective' | null;
  answer_version_id: string | null;
  answer_version: number | null;
  progress: 'solved' | 'attempted' | 'unseen' | null;
  best_score?: number | null;
}
export interface ProblemSummaries {
  items: ProblemSummary[];
}
