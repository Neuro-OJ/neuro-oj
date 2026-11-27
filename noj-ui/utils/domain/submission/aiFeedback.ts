/**
 * AI 评测可视化反馈（LLM Trace、分项能力雷达图、Badcase 行级对比）纯函数工具。
 */

import type {
  EvaluationFeedback,
  FeedbackBadcase,
  FeedbackMetric,
  FeedbackVisibility,
  LlmModelBreakdown,
  LlmSubmissionSummaryStats,
  LlmTraceItem,
  LlmTraceMessage,
} from '../../generated/api-contracts.ts';

export type LlmSummaryStats = LlmSubmissionSummaryStats;
export type {
  EvaluationFeedback,
  FeedbackBadcase,
  FeedbackMetric,
  FeedbackVisibility,
  LlmModelBreakdown,
  LlmSubmissionSummaryStats,
  LlmTraceItem,
  LlmTraceMessage,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asNonNegativeNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 规范化后端返回的反馈载荷，过滤不合规字段。 */
export function normalizeFeedbackPayload(raw: unknown): EvaluationFeedback | null {
  const obj = asRecord(raw);
  if (!obj) return null;

  const visibility: FeedbackVisibility = obj.visibility === 'hidden' || obj.visibility === 'summary'
    ? obj.visibility
    : 'cases';
  const visible = obj.visible === true && visibility !== 'hidden';
  if (!visible) {
    return {
      visible: false,
      visibility,
      attempt_id: null,
      gateway_available: false,
      summary: null,
      metrics: [],
      traces: [],
      badcases: [],
    };
  }

  const rawSummary = asRecord(obj.summary);
  const summary: LlmSummaryStats | null = rawSummary
    ? {
      total_calls: asNonNegativeNumber(rawSummary.total_calls),
      error_calls: asNonNegativeNumber(rawSummary.error_calls),
      prompt_tokens: asNonNegativeNumber(rawSummary.prompt_tokens),
      completion_tokens: asNonNegativeNumber(rawSummary.completion_tokens),
      cached_prompt_tokens: asNonNegativeNumber(rawSummary.cached_prompt_tokens),
      total_tokens: asNonNegativeNumber(rawSummary.total_tokens),
      estimated_cost: asNonNegativeNumber(rawSummary.estimated_cost),
      total_latency_ms: asNonNegativeNumber(rawSummary.total_latency_ms),
      avg_latency_ms: asNonNegativeNumber(rawSummary.avg_latency_ms),
      p95_latency_ms: asNonNegativeNumber(rawSummary.p95_latency_ms),
      models: Array.isArray(rawSummary.models)
        ? rawSummary.models
          .map((item) => asRecord(item))
          .filter((item): item is Record<string, unknown> => item !== null && typeof item.model === 'string')
          .map((item) => ({
            model: String(item.model),
            calls: asNonNegativeNumber(item.calls),
            total_tokens: asNonNegativeNumber(item.total_tokens),
            estimated_cost: asNonNegativeNumber(item.estimated_cost),
          }))
        : [],
    }
    : null;

  const metrics: FeedbackMetric[] = Array.isArray(obj.metrics)
    ? obj.metrics
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item.key === 'string' && typeof item.label === 'string' &&
        typeof item.score === 'number' && typeof item.max_score === 'number' && item.max_score > 0
      )
      .map((item) => ({
        key: String(item.key),
        label: String(item.label),
        score: asNonNegativeNumber(item.score),
        max_score: asNonNegativeNumber(item.max_score, 100),
      }))
    : [];

  const traces: LlmTraceItem[] = visibility === 'cases' && Array.isArray(obj.traces)
    ? obj.traces
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null && typeof item.id === 'string')
      .map((item, idx) => ({
        id: String(item.id),
        seq: asNonNegativeNumber(item.seq, idx + 1),
        model: typeof item.model === 'string' ? item.model : 'unknown',
        status: typeof item.status === 'string' ? item.status : 'ok',
        error_code: asNullableString(item.error_code),
        prompt_tokens: asNonNegativeNumber(item.prompt_tokens),
        completion_tokens: asNonNegativeNumber(item.completion_tokens),
        cached_prompt_tokens: asNonNegativeNumber(item.cached_prompt_tokens),
        total_tokens: asNonNegativeNumber(item.total_tokens),
        estimated_cost: asNonNegativeNumber(item.estimated_cost),
        latency_ms: asNonNegativeNumber(item.latency_ms),
        offset_ms: asNonNegativeNumber(item.offset_ms),
        created_at: typeof item.created_at === 'string' ? item.created_at : '',
        request_params: asRecord(item.request_params) ?? {},
        ...(Array.isArray(item.request_messages)
          ? { request_messages: item.request_messages as LlmTraceMessage[] }
          : {}),
      }))
    : [];

  const badcases: FeedbackBadcase[] = visibility === 'cases' && Array.isArray(obj.badcases)
    ? obj.badcases
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item.case_id === 'string' && typeof item.status === 'string'
      )
      .map((item) => ({
        case_id: String(item.case_id),
        status: String(item.status),
        score: asNullableNumber(item.score),
        max_score: asNullableNumber(item.max_score),
        error_type: asNullableString(item.error_type),
        reasoning: asNullableString(item.reasoning),
        input: asNullableString(item.input),
        expected_output: asNullableString(item.expected_output),
        actual_output: asNullableString(item.actual_output),
        time_ms: asNullableNumber(item.time_ms),
        memory_kb: asNullableNumber(item.memory_kb),
      }))
    : [];

  return {
    visible: true,
    visibility,
    attempt_id: asNullableString(obj.attempt_id),
    gateway_available: obj.gateway_available !== false,
    summary,
    metrics,
    traces,
    badcases,
  };
}

/** 格式化 Token 数量（超千按 k 简写）。 */
export function formatFeedbackTokens(tokens: number | null | undefined): string {
  if (tokens == null || !Number.isFinite(tokens)) return '--';
  if (tokens >= 100_000) return `${(tokens / 1000).toFixed(1)}k`;
  return Math.round(tokens).toLocaleString('en-US');
}

/** 格式化费用单位。 */
export function formatFeedbackCost(cost: number | null | undefined): string {
  if (cost == null || !Number.isFinite(cost)) return '--';
  return `${Math.round(cost).toLocaleString('en-US')} 单位`;
}

/** 格式化分项得分与满分。 */
export function formatMetricValue(metric: FeedbackMetric): string {
  const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1);
  return `${fmt(metric.score)} / ${fmt(metric.max_score)}`;
}

export interface RadarAxisPoint {
  key: string;
  label: string;
  score: number;
  maxScore: number;
  percent: number;
  scoreText: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  pointX: number;
  pointY: number;
  labelX: number;
  labelY: number;
  textAnchor: 'start' | 'middle' | 'end';
}

export interface RadarGeometry {
  size: number;
  center: number;
  radius: number;
  rings: string[];
  axes: RadarAxisPoint[];
  polygonPoints: string;
}

/**
 * 计算纯 SVG 雷达图坐标（支持 3+ 个维度，自动对齐文本锚点防止裁切）。
 */
export function computeRadarGeometry(
  metrics: readonly FeedbackMetric[],
  size = 280,
): RadarGeometry {
  const center = size / 2;
  const radius = size * 0.31;
  const count = metrics.length;
  if (count < 3) {
    return { size, center, radius, rings: [], axes: [], polygonPoints: '' };
  }

  const angleFor = (index: number) => -Math.PI / 2 + (index * 2 * Math.PI) / count;

  const rings = [0.25, 0.5, 0.75, 1].map((scale) => {
    const pts = Array.from({ length: count }, (_, idx) => {
      const a = angleFor(idx);
      const x = center + Math.cos(a) * radius * scale;
      const y = center + Math.sin(a) * radius * scale;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return pts.join(' ');
  });

  const axes: RadarAxisPoint[] = metrics.map((metric, idx) => {
    const a = angleFor(idx);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const rawRatio = metric.max_score > 0 ? metric.score / metric.max_score : 0;
    const ratio = Math.max(0, Math.min(1, rawRatio));

    const x2 = center + cos * radius;
    const y2 = center + sin * radius;
    const pointX = center + cos * radius * ratio;
    const pointY = center + sin * radius * ratio;
    const labelDist = radius + 22;
    const labelX = center + cos * labelDist;
    const labelY = center + sin * labelDist;
    const textAnchor: 'start' | 'middle' | 'end' = Math.abs(cos) < 0.2 ? 'middle' : cos > 0 ? 'start' : 'end';

    return {
      key: metric.key,
      label: metric.label,
      score: metric.score,
      maxScore: metric.max_score,
      percent: Math.round(ratio * 100),
      scoreText: formatMetricValue(metric),
      x1: Number(center.toFixed(1)),
      y1: Number(center.toFixed(1)),
      x2: Number(x2.toFixed(1)),
      y2: Number(y2.toFixed(1)),
      pointX: Number(pointX.toFixed(1)),
      pointY: Number(pointY.toFixed(1)),
      labelX: Number(labelX.toFixed(1)),
      labelY: Number(labelY.toFixed(1)),
      textAnchor,
    };
  });

  const polygonPoints = axes.map((a) => `${a.pointX},${a.pointY}`).join(' ');
  return { size, center, radius, rings, axes, polygonPoints };
}

/** 计算瀑布流总时间跨度（ms）。 */
export function computeTraceSpanMs(traces: readonly LlmTraceItem[]): number {
  if (traces.length === 0) return 1;
  return Math.max(1, ...traces.map((t) => Math.max(0, t.offset_ms) + Math.max(0, t.latency_ms)));
}

/** 计算单条 Trace 在瀑布流中的横向百分比定位。 */
export function computeTraceBarStyle(
  trace: Pick<LlmTraceItem, 'offset_ms' | 'latency_ms'>,
  totalSpanMs: number,
): { leftPercent: number; widthPercent: number } {
  const span = Math.max(1, totalSpanMs);
  const rawLeft = (Math.max(0, trace.offset_ms) / span) * 100;
  const leftPercent = Math.min(98, Math.max(0, Number(rawLeft.toFixed(2))));
  const rawWidth = (Math.max(0, trace.latency_ms) / span) * 100;
  const widthPercent = Math.min(100 - leftPercent, Math.max(2, Number(rawWidth.toFixed(2))));
  return { leftPercent, widthPercent };
}

export interface FeedbackDiffLine {
  type: 'equal' | 'removed' | 'added';
  text: string;
  expectedLineNo: number | null;
  actualLineNo: number | null;
}

function splitLines(text: string | null): string[] {
  if (text === null || text === '') return [];
  return text.replaceAll('\r\n', '\n').split('\n');
}

/**
 * 计算期望输出与实际输出的行级 Diff（中小输出走精确 LCS，超大文本退化为逐行对齐）。
 */
export function computeLineDiff(expected: string | null, actual: string | null): FeedbackDiffLine[] {
  const expLines = splitLines(expected);
  const actLines = splitLines(actual);

  if (expLines.length === 0 && actLines.length === 0) return [];
  if (expLines.length * actLines.length > 40_000) {
    const maxLen = Math.max(expLines.length, actLines.length);
    const fallback: FeedbackDiffLine[] = [];
    for (let i = 0; i < maxLen; i++) {
      const e = expLines[i];
      const a = actLines[i];
      if (e !== undefined && a !== undefined && e === a) {
        fallback.push({ type: 'equal', text: e, expectedLineNo: i + 1, actualLineNo: i + 1 });
      } else {
        if (e !== undefined) {
          fallback.push({ type: 'removed', text: e, expectedLineNo: i + 1, actualLineNo: null });
        }
        if (a !== undefined) {
          fallback.push({ type: 'added', text: a, expectedLineNo: null, actualLineNo: i + 1 });
        }
      }
    }
    return fallback;
  }

  const m = expLines.length;
  const n = actLines.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (expLines[i] === actLines[j]) {
        dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  const diff: FeedbackDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (expLines[i] === actLines[j]) {
      diff.push({ type: 'equal', text: expLines[i]!, expectedLineNo: i + 1, actualLineNo: j + 1 });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      diff.push({ type: 'removed', text: expLines[i]!, expectedLineNo: i + 1, actualLineNo: null });
      i += 1;
    } else {
      diff.push({ type: 'added', text: actLines[j]!, expectedLineNo: null, actualLineNo: j + 1 });
      j += 1;
    }
  }
  while (i < m) {
    diff.push({ type: 'removed', text: expLines[i]!, expectedLineNo: i + 1, actualLineNo: null });
    i += 1;
  }
  while (j < n) {
    diff.push({ type: 'added', text: actLines[j]!, expectedLineNo: null, actualLineNo: j + 1 });
    j += 1;
  }
  return diff;
}

const PASSED_BADCASE_STATUSES = new Set(['accepted', 'ac', 'pass', 'passed', 'ok', 'correct']);

/** 判断 Badcase 是否属于未通过（区别于仅未满分）。 */
export function isBadcaseFailedStatus(status: string): boolean {
  return !PASSED_BADCASE_STATUSES.has(status.toLowerCase());
}
