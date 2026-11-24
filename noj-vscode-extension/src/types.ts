/** Neuro OJ 登录用户的最小响应字段。 */
export interface User {
  id: string;
  username: string;
  email?: string;
  must_change_password?: boolean;
}

/** IDE 题目列表所需的公开字段。 */
export interface Problem {
  id: string;
  display_id: string;
  title: string;
  difficulty: string;
  is_objective: boolean;
  submission_mode: "code" | "artifact" | "prediction";
}

/** 题目样例。 */
export interface ProblemSample {
  input?: string;
  output?: string;
  explanation?: string;
}

/** 题目资源限制。 */
export interface ProblemLimits {
  time_limit_ms?: number;
  memory_limit_mb?: number;
}

/** 域内题目详情响应（`GET /api/v1/domains/:slug/problems/:reference`）。 */
export interface DomainProblemDetail {
  reference?: {
    problem_id?: string;
    display_ref?: string;
    source_domain_slug?: string;
  };
  version_id: string;
  version: number;
  supported_languages?: string[];
  submission_mode?: "code" | "artifact" | "prediction" | "ui";
  judge_type?: "dual" | "oi";
  limits?: ProblemLimits | null;
  content: {
    title: string;
    description?: string;
    samples?: ProblemSample[];
    submission_mode?: string;
    judge_type?: string;
  };
}

/** 创建代码或产物提交后的响应字段。 */
export interface CreatedSubmission {
  id: string;
  public_id?: string;
  status: SubmissionStatus;
}

export type SubmissionStatus = "pending" | "judging" | "finished" | "error";

/** 评测结果详情。分数沿用服务端协议，为放大 100 倍的整数。 */
export interface EvaluationResult {
  status: string;
  score: number | null;
  output: string | null;
  output_truncated: boolean | null;
  time_ms: number | null;
  memory_kb: number | null;
  details: Record<string, unknown> | null;
}

/** 题目详情的版本元数据。 */
export interface ProblemVersionInfo {
  version_id: string | null;
  version: number | null;
  latest_version_id: string | null;
  latest_version: number | null;
  effective_version_policy: EffectiveVersionPolicy;
  is_latest: boolean;
}

/** 有效版本策略（与 core 的 `EffectiveVersionPolicy` 对齐）。 */
export type EffectiveVersionPolicy =
  { mode: "any" } | { mode: "exact"; version_id: string | null };

/** 题目详情（版本元数据 + 列表字段）。 */
export interface ProblemDetail extends ProblemVersionInfo {
  id: string;
  title: string;
}

/** 提交详情响应。 */
export interface SubmissionDetail extends Omit<CreatedSubmission, "status"> {
  /** OI 赛时仅返回回执，状态不用于推断评测判定。 */
  status?: SubmissionStatus;
  result_visibility?: "hidden" | "summary" | "cases";
  problem_id: string;
  file_name: string;
  result: EvaluationResult | null;
  queue_position: number | null;
  queue_length: number | null;
}

/** 保存在扩展状态中的当前题目摘要。 */
export interface SelectedProblem {
  domainSlug?: string;
  reference?: string;
  id: string;
  displayId: string;
  title: string;
  /**
   * 选定题目时固定的作答版本（Handbook §4.2）。
   * 提交必须携带它；服务端返回 409 时提示刷新重选。
   */
  versionId: string | null;
  version: number | null;
  submissionMode?: "code" | "artifact" | "prediction";
  judgeType?: "dual" | "oi";
}

/** 当前账号可用的工作空间。 */
export interface Domain {
  id: string;
  slug: string;
  name: string;
  status: "active" | "archived" | "suspended";
}

export interface DomainProblem {
  reference: {
    problem_id: string;
    display_ref: string;
    source_domain_slug: string;
  };
  title: string;
  kind: "oi" | "ai" | "objective";
  version_id: string;
  version: number;
  submission_mode?: "code" | "artifact" | "prediction" | "ui";
}

/** 落盘在 `.noj/problem.json` 的工作区题目绑定配置。 */
export interface WorkspaceProblemConfig {
  serverUrl: string;
  domainSlug: string;
  reference: string;
  versionId: string;
  version: number | null;
  entryFile: string;
  submissionMode: "code" | "artifact" | "prediction";
  judgeType: "dual" | "oi";
}

/** 云端自测状态。 */
export type SelfTestStatus =
  "pending" | "judging" | "finished" | "error" | "cancelled";

/** 自测样例输入。 */
export interface SelfTestCaseInput {
  input: string;
  expected_output?: string;
}

/** 创建自测响应。 */
export interface SelfTestCreated {
  id: string;
  status: SelfTestStatus;
  problem_id: string;
  file_name?: string | null;
}

/** 云端自测详情响应。 */
export interface SelfTestDetail {
  id: string;
  problem_id: string;
  file_name: string | null;
  status: SelfTestStatus;
  result_status: string | null;
  score: number;
  output: string | null;
  output_truncated: boolean | null;
  details: Record<string, unknown> | null;
  time_ms: number | null;
  memory_kb: number | null;
}

/** 单次 LLM 调用 Trace 记录（本地 Mock 与线上反馈共用）。 */
export interface LlmTraceEntry {
  index: number;
  model: string;
  startedAtMs: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  status: "ok" | "error";
  requestPreview: string;
  responsePreview: string;
}

/** 能力维度得分（用于 SVG 雷达图）。 */
export interface EvaluationDimensionScore {
  name: string;
  score: number;
  maxScore: number;
}

/** 源码定位信息，支持在报告中点击跳转编辑器行号。 */
export interface SourceLocation {
  file: string;
  line: number;
}

/** 失败用例 / Badcase 对比条目。 */
export interface EvaluationBadcase {
  caseId: string;
  status: string;
  input?: string;
  expected?: string;
  actual?: string;
  message?: string;
  location?: SourceLocation;
}

/** 可视化评测报告的统一数据模型。 */
export interface EvaluationFeedback {
  source: "submission" | "self_test" | "local_mock";
  title: string;
  status: string;
  score: number | null;
  maxScore: number;
  hidden?: boolean;
  summary?: string;
  output?: string;
  outputTruncated?: boolean;
  timeMs?: number | null;
  memoryKb?: number | null;
  metering?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd?: number | null;
    callCount: number;
  };
  dimensions: EvaluationDimensionScore[];
  badcases: EvaluationBadcase[];
  traces: LlmTraceEntry[];
  locations: SourceLocation[];
}

/** `.noj/mock-llm.json` 预设规则。 */
export interface MockLlmRule {
  match?: string;
  reply: string;
  delayMs?: number;
  model?: string;
}

/** `.noj/mock-llm.json` 配置文件结构。 */
export interface MockLlmConfig {
  defaultReply?: string;
  defaultDelayMs?: number;
  rules?: MockLlmRule[];
}
