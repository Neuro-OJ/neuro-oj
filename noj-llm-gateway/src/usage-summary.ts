/**
 * 提交 / 尝试维度的 LLM 用量聚合与 Trace 脱敏构造。
 */
import type { Db } from "./db.ts";

/** 单条 Trace 对外视图。 */
export interface SubmissionUsageTrace {
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
  request_messages?: unknown[];
}

/** 按模型聚合的用量统计。 */
export interface SubmissionUsageModelSummary {
  model: string;
  calls: number;
  total_tokens: number;
  estimated_cost: number;
}

/** 提交维度的 LLM 用量汇总。 */
export interface SubmissionUsageSummaryStats {
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
  models: SubmissionUsageModelSummary[];
}

/** `/internal/usage/submission-summary` 的 data 载荷。 */
export interface SubmissionUsageSummaryResult {
  summary: SubmissionUsageSummaryStats;
  traces: SubmissionUsageTrace[];
}

/** 数据库 `llm_usage` 查询行结构。 */
export interface RawSubmissionUsageRow {
  id: string;
  model: string;
  status: string;
  error_code?: string | null;
  prompt_tokens: number | string;
  completion_tokens: number | string;
  cached_prompt_tokens?: number | string | null;
  total_tokens: number | string;
  estimated_cost: number | string;
  latency_ms: number | string;
  created_at: string;
  request_params?: unknown;
  request_messages?: unknown;
}

const MAX_MESSAGE_CONTENT_CHARS = 4000;
const MAX_TOTAL_MESSAGES_CHARS = 32 * 1024;
const MAX_SUMMARY_TRACE_ROWS = 1000;

function toNonNegativeNumber(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeRequestParams(raw: unknown): Record<string, unknown> {
  const parsed = parseJsonValue(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

/**
 * 对文本中的高危密钥模式脱敏，并截断超长正文以防止大包泄露。
 */
export function redactMessageText(
  text: string,
  maxChars = MAX_MESSAGE_CONTENT_CHARS,
): string {
  const redacted = text
    .replace(/\bBearer\s+[A-Za-z0-9._\-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_\-]{12,}/g, "sk-[REDACTED]");
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}\n...[truncated ${
    redacted.length - maxChars
  } chars]`;
}

function sanitizeMessageContent(content: unknown): unknown {
  if (typeof content === "string") {
    return redactMessageText(content);
  }
  if (Array.isArray(content)) {
    return content.slice(0, 20).map((part) => {
      if (!part || typeof part !== "object") return part;
      const obj = part as Record<string, unknown>;
      if (typeof obj.text === "string") {
        return { ...obj, text: redactMessageText(obj.text) };
      }
      return obj;
    });
  }
  return content;
}

/**
 * 脱敏并限制 `request_messages` 体积：只保留消息角色、正文与工具调用元数据，
 * 移除意外字段并对疑似凭据脱敏。
 */
export function sanitizeMessagesForTrace(raw: unknown): unknown[] {
  const parsed = parseJsonValue(raw);
  if (!Array.isArray(parsed)) return [];
  const result: unknown[] = [];
  let totalChars = 0;

  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const msg = item as Record<string, unknown>;
    const clean: Record<string, unknown> = {
      role: typeof msg.role === "string" ? msg.role : "unknown",
    };
    if (msg.content !== undefined) {
      clean.content = sanitizeMessageContent(msg.content);
    }
    if (typeof msg.name === "string") {
      clean.name = msg.name;
    }
    if (typeof msg.tool_call_id === "string") {
      clean.tool_call_id = msg.tool_call_id;
    }
    if (Array.isArray(msg.tool_calls)) {
      clean.tool_calls = msg.tool_calls.slice(0, 20);
    }
    const serializedLen = JSON.stringify(clean).length;
    if (
      totalChars + serializedLen > MAX_TOTAL_MESSAGES_CHARS && result.length > 0
    ) {
      result.push({
        role: "system",
        content:
          `[messages_truncated: exceeded ${MAX_TOTAL_MESSAGES_CHARS} chars display budget]`,
      });
      break;
    }
    totalChars += serializedLen;
    result.push(clean);
  }
  return result;
}

/**
 * 计算 nearest-rank P95 延迟（ms）。空数组返回 0。
 */
export function computeP95Latency(latencies: readonly number[]): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * 0.95) - 1),
  );
  return sorted[index] ?? 0;
}

function resolveTraceLimit(limit?: number): number {
  if (limit === undefined) return MAX_SUMMARY_TRACE_ROWS;
  if (!Number.isFinite(limit)) return MAX_SUMMARY_TRACE_ROWS;
  return Math.min(MAX_SUMMARY_TRACE_ROWS, Math.max(0, Math.floor(limit)));
}

/**
 * 将匹配到的 `llm_usage` 全量行聚合为 summary + 截断后的 traces 瀑布流视图：
 * - 以推导请求起始时间 `start_ms = created_at_ms - Math.max(0, latency_ms)` 作为时间轴依据，
 *   按 `(start_ms ASC, created_at ASC, id ASC)` 排序并以 `earliest_start_ms` 计算 `offset_ms`；
 * - 对全量匹配行汇总统计，仅对返回的 `traces` 列表应用展示条数上限（默认 1000）。
 */
export function buildSubmissionUsageSummary(
  rows: readonly RawSubmissionUsageRow[],
  options: { includeMessages?: boolean; limit?: number } = {},
): SubmissionUsageSummaryResult {
  const includeMessages = options.includeMessages === true;
  const traceLimit = resolveTraceLimit(options.limit);

  const indexed = rows.map((row) => {
    const createdAtMs = Date.parse(row.created_at);
    const latencyMs = toNonNegativeNumber(row.latency_ms);
    const startMs = Number.isFinite(createdAtMs)
      ? createdAtMs - Math.max(0, latencyMs)
      : Number.NaN;
    return { row, latencyMs, startMs };
  });

  indexed.sort((a, b) => {
    const aValid = Number.isFinite(a.startMs);
    const bValid = Number.isFinite(b.startMs);
    if (aValid && bValid && a.startMs !== b.startMs) {
      return a.startMs - b.startMs;
    }
    if (aValid !== bValid) return aValid ? -1 : 1;
    return a.row.created_at.localeCompare(b.row.created_at) ||
      a.row.id.localeCompare(b.row.id);
  });

  let errorCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedPromptTokens = 0;
  let totalTokens = 0;
  let estimatedCost = 0;
  let totalLatencyMs = 0;
  const latencies: number[] = [];
  const modelMap = new Map<string, SubmissionUsageModelSummary>();

  for (const { row, latencyMs } of indexed) {
    const rowPrompt = toNonNegativeNumber(row.prompt_tokens);
    const rowCompletion = toNonNegativeNumber(row.completion_tokens);
    const rowCached = toNonNegativeNumber(row.cached_prompt_tokens);
    const rowTotal = toNonNegativeNumber(row.total_tokens);
    const rowCost = toNonNegativeNumber(row.estimated_cost);
    const status = typeof row.status === "string" && row.status
      ? row.status
      : "ok";
    const model = typeof row.model === "string" && row.model
      ? row.model
      : "unknown";

    if (status !== "ok") errorCalls += 1;
    promptTokens += rowPrompt;
    completionTokens += rowCompletion;
    cachedPromptTokens += rowCached;
    totalTokens += rowTotal;
    estimatedCost += rowCost;
    totalLatencyMs += latencyMs;
    latencies.push(latencyMs);

    const existing = modelMap.get(model);
    if (existing) {
      existing.calls += 1;
      existing.total_tokens += rowTotal;
      existing.estimated_cost += rowCost;
    } else {
      modelMap.set(model, {
        model,
        calls: 1,
        total_tokens: rowTotal,
        estimated_cost: rowCost,
      });
    }
  }

  const earliestStartMs =
    indexed.length > 0 && Number.isFinite(indexed[0]!.startMs)
      ? indexed[0]!.startMs
      : Number.NaN;

  const traces: SubmissionUsageTrace[] = indexed
    .slice(0, traceLimit)
    .map(({ row, latencyMs, startMs }, index) => {
      const status = typeof row.status === "string" && row.status
        ? row.status
        : "ok";
      const model = typeof row.model === "string" && row.model
        ? row.model
        : "unknown";
      const offsetMs =
        Number.isFinite(earliestStartMs) && Number.isFinite(startMs)
          ? Math.max(0, startMs - earliestStartMs)
          : 0;

      const trace: SubmissionUsageTrace = {
        id: row.id,
        seq: index + 1,
        model,
        status,
        error_code: row.error_code ?? null,
        prompt_tokens: toNonNegativeNumber(row.prompt_tokens),
        completion_tokens: toNonNegativeNumber(row.completion_tokens),
        cached_prompt_tokens: toNonNegativeNumber(row.cached_prompt_tokens),
        total_tokens: toNonNegativeNumber(row.total_tokens),
        estimated_cost: toNonNegativeNumber(row.estimated_cost),
        latency_ms: latencyMs,
        offset_ms: offsetMs,
        created_at: row.created_at,
        request_params: normalizeRequestParams(row.request_params),
      };
      if (includeMessages) {
        trace.request_messages = sanitizeMessagesForTrace(row.request_messages);
      }
      return trace;
    });

  const totalCalls = indexed.length;
  const models = [...modelMap.values()].sort((a, b) =>
    b.calls - a.calls || b.total_tokens - a.total_tokens ||
    a.model.localeCompare(b.model)
  );

  return {
    summary: {
      total_calls: totalCalls,
      error_calls: errorCalls,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cached_prompt_tokens: cachedPromptTokens,
      total_tokens: totalTokens,
      estimated_cost: estimatedCost,
      total_latency_ms: totalLatencyMs,
      avg_latency_ms: totalCalls > 0
        ? Math.round(totalLatencyMs / totalCalls)
        : 0,
      p95_latency_ms: computeP95Latency(latencies),
      models,
    },
    traces,
  };
}

/**
 * 查询某次提交或尝试在指定使用域下的全量 LLM 调用记录并构造聚合视图。
 * 统计字段覆盖全部匹配行，仅对返回的 `traces` 列表按 `limit`（默认 1000）截断。
 */
export async function querySubmissionUsageSummary(
  db: Db,
  input: {
    domainId: string;
    submissionId?: string;
    attemptId?: string;
    includeMessages?: boolean;
    limit?: number;
  },
): Promise<SubmissionUsageSummaryResult> {
  const includeMessages = input.includeMessages === true;
  const selectColumns = includeMessages
    ? "id, model, status, error_code, prompt_tokens, completion_tokens, cached_prompt_tokens, total_tokens, estimated_cost, latency_ms, created_at, request_params, request_messages"
    : "id, model, status, error_code, prompt_tokens, completion_tokens, cached_prompt_tokens, total_tokens, estimated_cost, latency_ms, created_at, request_params";

  const conditions: string[] = [
    "domain_id = $1",
    "principal_type = 'user'",
  ];
  const params: unknown[] = [input.domainId];

  if (input.submissionId) {
    params.push(input.submissionId);
    conditions.push(`submission_id = $${params.length}`);
  }
  if (input.attemptId) {
    params.push(input.attemptId);
    conditions.push(`attempt_id = $${params.length}`);
  }

  const sql = `SELECT ${selectColumns} FROM llm_usage WHERE ${
    conditions.join(" AND ")
  } ORDER BY created_at ASC, id ASC`;

  const rows = await db.unsafe(
    sql,
    params as never,
  ) as unknown as RawSubmissionUsageRow[];
  return buildSubmissionUsageSummary(rows, {
    includeMessages,
    limit: input.limit,
  });
}
