/**
 * 已迁入 `features/` 的核心 API 契约（前后端 & VS Code 扩展共享的唯一事实源）。
 *
 * 约束：
 * - 只能包含纯 TypeScript 类型与字面量常量，不得导入运行时模块或 Deno/Node 专属 API；
 * - 修改本文件后需运行 `deno run -A scripts/gen-api-contracts.ts` 同步各端生成文件；
 * - CI 由 `scripts/gen-api-contracts.ts --check` 拦截三端契约漂移。
 */

// ── Checkin（每日签到） ──────────────────────────────────────

/** 签到操作 / 今日状态的响应。 */
export interface CheckInResponse {
  checked_in: boolean;
  streak: number;
}

/** 签到统计结果。 */
export interface CheckinStats {
  /** 累计签到天数 */
  total_days: number;
  /** 当前连续天数（今日未签到时为昨日 streak，未连续则为 0） */
  current_streak: number;
  /** 历史最长连续天数 */
  max_streak: number;
  /** 指定月份（默认当月，UTC）签到天数 */
  month_days: number;
  /** 最近签到日期（YYYY-MM-DD），从未签到为 null */
  last_checkin_date: string | null;
}

/** 签到历史结果。 */
export interface CheckinHistory {
  /** 最近 N 天内已签到的日期（升序，含今日） */
  days: string[];
  total_days: number;
}

/** 签到活跃榜单行数据。 */
export interface CheckinLeaderboardRow {
  rank: number;
  user_id: string;
  username: string;
  /** 当月签到天数 */
  days: number;
}

/** 签到活跃榜响应。 */
export interface CheckinLeaderboard {
  data: CheckinLeaderboardRow[];
  total: number;
  /** 当前用户当月排名（未上榜 / 未登录为 null） */
  user_rank: number | null;
}

// ── Tags（题目标签） ────────────────────────────────────────

/** 标签 kind 类型：problem=题目标签，algorithm=算法标签。 */
export type TagKind = "problem" | "algorithm";

/** 标签 kind 枚举。 */
export const TAG_KINDS: readonly TagKind[] = ["problem", "algorithm"];

/** 标签响应 DTO。 */
export interface TagResponse {
  id: string;
  name: string;
  kind: TagKind;
  /** 关联题目数（管理页表格展示）。 */
  problem_count: number;
  created_at: string;
  updated_at: string;
}

/** 创建标签的输入。 */
export interface CreateTagInput {
  name: string;
  kind: string;
}

/** 更新标签的输入（字段可选，仅更新提供的字段）。 */
export interface UpdateTagInput {
  name?: string;
  kind?: string;
}

// ── Trainings（域题单） ──────────────────────────────────────

/** 域题单创建/更新请求体。 */
export interface DomainTrainingInput {
  state?: "draft" | "published";
  title: string;
  description?: string;
  visibility?: "private" | "unlisted" | "public";
  problems: string[];
}

// ── BYOK（用户自带模型） ─────────────────────────────────────

/** 用户自带模型视图（Key 已由 gateway 脱敏）。 */
export interface UserLlmProviderView {
  provider_id: string;
  base_url: string;
  model: string;
  api_key_masked: string;
  enabled: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
}

/** 用户自带模型写入字段（白名单，其他字段不会转发）。 */
export interface UserLlmProviderInput {
  base_url?: string;
  model?: string;
  api_key?: string;
  enabled?: boolean;
}

/** 设置页读取到的 BYOK 状态。 */
export interface ByokState {
  /** 实例是否开启 BYOK（gateway 白名单非空） */
  enabled: boolean;
  /** 允许的上游主机（精确匹配，仅 https） */
  allowed_hosts: string[];
  /** 当前用户的自带模型；未配置为 null */
  provider: UserLlmProviderView | null;
}

/** BYOK 连通性测试结果：上游类失败以 `failed` 返回，便于前端直接展示。 */
export interface ByokTestResult {
  status: "ok" | "failed";
  code?: string;
  message?: string;
}

// ── Evaluation Feedback & LLM Trace（AI 评测可视化反馈） ─────

/** 评测反馈对外可见级别，与提交/竞赛投影口径一致。 */
export type FeedbackVisibility = "hidden" | "summary" | "cases";

/** 能力维度分项评分，供雷达图等可视化组件渲染。 */
export interface FeedbackMetric {
  key: string;
  label: string;
  score: number;
  max_score: number;
}

/** 按模型汇总的 LLM 用量条目。 */
export interface LlmModelBreakdown {
  model: string;
  calls: number;
  total_tokens: number;
  estimated_cost: number;
}

/** 单次提交的 LLM 用量与延迟汇总统计。 */
export interface LlmSubmissionSummaryStats {
  total_calls: number;
  error_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  total_latency_ms: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  models: LlmModelBreakdown[];
}

/** 脱敏后的单条请求消息（仅教练/管理员开启 include_messages 时返回）。 */
export interface LlmTraceMessage {
  role?: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
  [key: string]: unknown;
}

/** 单次 LLM 调用的瀑布流 Trace 记录。 */
export interface LlmTraceItem {
  id: string;
  seq: number;
  model: string;
  status: string;
  error_code: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  latency_ms: number;
  offset_ms: number;
  created_at: string;
  request_params: Record<string, unknown>;
  request_messages?: LlmTraceMessage[];
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
