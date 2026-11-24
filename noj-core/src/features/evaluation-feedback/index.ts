/**
 * AI 评测可视化反馈功能对外出口。
 *
 * 提供正式提交与自测的 LLM Trace、分项能力指标与可见 Badcase 对比视图，
 * 严格遵循竞赛可见性与隐藏测试点防作弊门控。
 */
import { defineFeature } from "../../shared/feature.ts";
import { evaluationFeedbackRouter } from "./routes.ts";

export const feature = defineFeature({
  name: "evaluation-feedback",
  router: evaluationFeedbackRouter,
});

export {
  extractFeedbackMetrics,
  extractVisibleCasesAndBadcases,
  type FeedbackServiceDeps,
  getSelfTestFeedback,
  getSubmissionFeedback,
  isFeedbackCasePassed,
  type NormalizedFeedbackCase,
  resolveIncludeMessagesFlag,
} from "./service.ts";
export {
  createEvaluationFeedbackRouter,
  evaluationFeedbackRouter,
} from "./routes.ts";
export type {
  EvaluationFeedback,
  FeedbackBadcase,
  FeedbackMetric,
  FeedbackVisibility,
} from "./types.ts";
