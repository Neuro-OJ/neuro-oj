import type {
  LlmSubmissionSummaryStats,
  LlmTraceItem,
} from "../../modules/platform/index.ts";

/** 评测反馈对外可见级别，与提交/竞赛投影口径一致。 */
export type FeedbackVisibility = "hidden" | "summary" | "cases";

/** 能力维度分项评分，供雷达图等可视化组件渲染。 */
export interface FeedbackMetric {
  key: string;
  label: string;
  score: number;
  max_score: number;
}

/** 可见未通过或未满分的测试用例对比条目。 */
export interface FeedbackBadcase {
  case_id: string;
  status: string;
  score: number | null;
  max_score: number | null;
  error_type: string | null;
  reasoning: string | null;
  input: string | null;
  expected_output: string | null;
  actual_output: string | null;
  time_ms: number | null;
  memory_kb: number | null;
}

/** `/domains/:slug/submissions/:id/feedback` 与 `/self-tests/:id/feedback` 统一响应体。 */
export interface EvaluationFeedback {
  visible: boolean;
  visibility: FeedbackVisibility;
  attempt_id: string | null;
  gateway_available: boolean;
  summary: LlmSubmissionSummaryStats | null;
  metrics: FeedbackMetric[];
  traces: LlmTraceItem[];
  badcases: FeedbackBadcase[];
}
