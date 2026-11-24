/**
 * 模拟赛压测套件共享类型与默认配置（无运行时副作用，供离线仿真与 live HTTP 执行器共用）。
 */

export type ProblemKind = "ai" | "oi";
export type PriorityTier = "high" | "medium" | "low";

export interface UserCredentialEntry {
  token?: string;
  login?: string;
  password?: string;
}

export interface PriorityMix {
  high: number;
  medium: number;
  low: number;
}

export interface LoadThresholds {
  /** 允许的最大错误率（0..1，不含成功降级的重试；默认 0.02）。 */
  maxErrorRate: number;
  /** P95 端到端延迟上限（毫秒）。 */
  maxP95Ms: number;
  /** P99 端到端延迟上限（毫秒）。 */
  maxP99Ms: number;
  /** 低优先级任务最低完成率（防止高优先级洪峰饿死 low 队列，默认 0.95）。 */
  minLowCompletionRate: number;
}

export interface MockTransportProfile {
  /** 模拟并发评测 Worker 槽位数（默认 4）。 */
  workerSlots?: number;
  /** AI 题型单次评测基础耗时（毫秒，默认 45）。 */
  aiBaseJudgeMs?: number;
  /** OI 题型单次评测基础耗时（毫秒，默认 25）。 */
  oiBaseJudgeMs?: number;
  /** 触发 503 背压的在途队列深度阈值（默认不限制）。 */
  backpressureQueueLimit?: number;
  /** 触发 429 限流的单波次并发阈值（默认不限制）。 */
  rateLimitBurstThreshold?: number;
  /** 人工注入失败率（0..1，默认 0）。 */
  injectedFailureRate?: number;
}

export interface LoadTestConfig {
  mode: "dry-run" | "live";
  baseUrl: string;
  adminToken?: string;
  /** 多用户独立认证 Token 列表（--user-tokens）。 */
  userTokens?: string[];
  /** 多用户凭据 JSON 文件路径（--user-credentials-file）。 */
  userCredentialsFile?: string;
  /** 可直接传入的多用户凭据数组（便于单测或编程调用）。 */
  userCredentials?: UserCredentialEntry[];
  /** 是否在缺少独立 Token 时自动通过注册/管理员开号获取多用户 Token（--auto-register）。 */
  autoRegister?: boolean;
  /** 是否显式允许 --users > 1 时共享单账号 Token（--allow-shared-user）。 */
  allowSharedUser?: boolean;
  /** 准备期鉴权/开号/入域/报名请求之间的最小节流间隔（毫秒，--auth-pace-ms）。 */
  authPaceMs?: number;
  /** 准备期鉴权请求遇到 HTTP 429 时的最大重试次数（默认 6）。 */
  authMaxRetries?: number;
  /** live 模式调度发送阶段并发 POST 连接上限。 */
  postConcurrency?: number;
  /** live 模式异步轮询阶段并发 GET 连接上限。 */
  pollConcurrency?: number;
  /** 目标使用域 slug（默认 "main"）。 */
  domainSlug?: string;
  contestId?: string;
  aiProblemId?: string;
  oiProblemId?: string;
  /** 显式指定版本 ID（未提供时 live 模式在压测前自动调用域题目详情解析）。 */
  versionId?: string;
  aiVersionId?: string;
  oiVersionId?: string;
  /** 显式指定竞赛锁定版本 ID（--contest-version-id；省略时从竞赛题目列表解析）。 */
  contestVersionId?: string;
  aiContestVersionId?: string;
  oiContestVersionId?: string;
  /** 竞赛赛题标签（未指定时尝试从赛题列表按 reference 匹配，回退为 "A"）。 */
  aiContestLabel?: string;
  oiContestLabel?: string;
  /** live 模式 low 优先级重测所用的目标提交 ID（缺省时自动复用已完成的提交）。 */
  rejudgeSubmissionIds?: string[];
  /** 可注入 HTTP fetch 实现（默认 globalThis.fetch，便于单测离线校验 live 契约）。 */
  fetchFn?: typeof fetch;
  /** 并发虚拟用户数。 */
  users: number;
  /** 波峰总提交数。 */
  peakSubmissions: number;
  /** AI 题型占比（0..1，剩余为 OI 题型）。 */
  aiRatio: number;
  /** 优先级分布比例。 */
  priorityMix: PriorityMix;
  /** 波峰注入时间窗口（毫秒，0 表示瞬间并发）。 */
  burstWindowMs: number;
  /** live 模式下状态轮询间隔（毫秒）。 */
  pollIntervalMs: number;
  /** 单次提交最长等待超时（毫秒）。 */
  timeoutMs: number;
  /** 验收告警阈值。 */
  thresholds: LoadThresholds;
  /** dry-run 模式下的仿真参数。 */
  mockProfile?: MockTransportProfile;
}

export interface WorkloadItem {
  index: number;
  userId: string;
  problemKind: ProblemKind;
  priority: PriorityTier;
}

export interface SubmissionRecord {
  index: number;
  userId: string;
  problemKind: ProblemKind;
  priority: PriorityTier;
  /** 发送时间戳（相对压测起点毫秒）。 */
  sentAtMs?: number;
  /** POST 受理时间戳（相对压测起点毫秒）。 */
  acceptedAtMs?: number;
  /** 入队/提交耗时（毫秒）。 */
  submitHttpMs: number;
  /** 排队等待时长（毫秒）。 */
  queueWaitMs: number;
  /** 提交到终态的端到端延迟（毫秒）。 */
  e2eLatencyMs: number;
  /** 完成时间戳（相对压测起点毫秒）。 */
  completedAtMs: number;
  httpStatus: number;
  outcome: "ok" | "rate_limited" | "backpressure" | "timeout" | "error";
  error?: string;
}

export interface LatencySummary {
  min: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface TierStats {
  total: number;
  succeeded: number;
  failed: number;
  completionRate: number;
  e2eLatencyMs: LatencySummary;
  queueWaitMs: LatencySummary;
}

export interface PriorityFairnessReport {
  /** 是否满足 high/medium/low 的 4:2:1 优先级调度预期（high 平均等待 <= low 或竞争期占比符合权重）。 */
  fairnessPassed: boolean;
  /** 低优先级任务是否发生饥饿（完成率低于阈值）。 */
  lowStarved: boolean;
  /** high 与 low 的平均排队延迟比（越小表示 high 越优先）。 */
  highToLowWaitRatio: number;
  /** 竞争阶段（前 50% 完成窗口内）各优先级占比。 */
  earlyWindowCounts: Record<PriorityTier, number>;
  notes: string[];
}

export interface LoadTestStats {
  totalSubmissions: number;
  succeeded: number;
  failed: number;
  errorRate: number;
  rateLimited429: number;
  backpressure503: number;
  timeouts: number;
  totalWallMs: number;
  throughputPerSec: number;
  e2eLatencyMs: LatencySummary;
  queueWaitMs: LatencySummary;
  byProblemKind: Record<ProblemKind, TierStats>;
  byPriority: Record<PriorityTier, TierStats>;
  priorityFairness: PriorityFairnessReport;
}

export interface ThresholdEvaluation {
  passed: boolean;
  violations: string[];
  warnings: string[];
}

export interface LoadTestReport {
  mode: "dry-run" | "live";
  executedAt: string;
  config: Omit<
    LoadTestConfig,
    "adminToken" | "userTokens" | "userCredentials" | "fetchFn"
  >;
  stats: LoadTestStats;
  evaluation: ThresholdEvaluation;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 构造默认压测配置。 */
export function defaultLoadTestConfig(): LoadTestConfig {
  return {
    mode: "dry-run",
    baseUrl: Deno.env.get("E2E_BASE_URL") ?? "http://localhost:8099",
    domainSlug: "main",
    users: 20,
    peakSubmissions: 70,
    aiRatio: 0.5,
    priorityMix: { high: 0.57, medium: 0.29, low: 0.14 },
    burstWindowMs: 200,
    pollIntervalMs: 300,
    timeoutMs: 60_000,
    thresholds: {
      maxErrorRate: 0.02,
      maxP95Ms: 15_000,
      maxP99Ms: 30_000,
      minLowCompletionRate: 0.95,
    },
  };
}
