/** 受当前使用域授权的题目展示摘要，不包含题面或私有评测配置。 */
export interface ProblemSummary {
  reference: string;
  title: string | null;
  error: boolean;
}
export interface ProblemSummaries {
  items: ProblemSummary[];
}
