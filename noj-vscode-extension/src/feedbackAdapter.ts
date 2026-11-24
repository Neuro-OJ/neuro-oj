import type {
  EvaluationBadcase,
  EvaluationDimensionScore,
  EvaluationFeedback,
  LlmTraceEntry,
  SelfTestDetail,
  SourceLocation,
  SubmissionDetail,
} from "./types";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 从文本中提取源码位置（如 `submission.py:42` 或 Python traceback `File "a.py", line 12`）。 */
export function extractSourceLocations(text: string): SourceLocation[] {
  const seen = new Set<string>();
  const locations: SourceLocation[] = [];

  const push = (file: string, lineRaw: string) => {
    const line = Number(lineRaw);
    if (!file || !Number.isInteger(line) || line <= 0) return;
    const key = `${file}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    locations.push({ file, line });
  };

  const tracebackRe = /File "([^"\r\n]+)", line (\d+)/g;
  for (const match of text.matchAll(tracebackRe)) {
    push(match[1], match[2]);
  }

  const inlineRe = /(?:^|[\s(])([A-Za-z0-9_./-]+\.py):(\d+)\b/g;
  for (const match of text.matchAll(inlineRe)) {
    push(match[1], match[2]);
  }

  return locations;
}

/** 将放大 100 倍的整数分或直出百分制分标准化为 0..100 分。 */
function normalizeScaledScore(
  rawScore: number | null | undefined,
  maxScore = 100,
): number | null {
  if (rawScore === null || rawScore === undefined) return null;
  if (maxScore === 100 && rawScore > 100) {
    return Number((rawScore / 100).toFixed(2));
  }
  return Number(rawScore.toFixed(2));
}

function parseDimensions(
  source: Record<string, unknown> | undefined,
): EvaluationDimensionScore[] {
  if (!source) return [];
  const rawList = Array.isArray(source.metrics)
    ? source.metrics
    : Array.isArray(source.dimensions)
      ? source.dimensions
      : Array.isArray(source.radar)
        ? source.radar
        : undefined;
  if (rawList) {
    const parsed: EvaluationDimensionScore[] = [];
    for (const item of rawList) {
      const rec = asRecord(item);
      if (!rec) continue;
      const name =
        asString(rec.name) ?? asString(rec.label) ?? asString(rec.key);
      const score = asNumber(rec.score) ?? asNumber(rec.value);
      if (!name || score === undefined) continue;
      const maxScore = asNumber(rec.max_score) ?? asNumber(rec.maxScore) ?? 100;
      parsed.push({
        name,
        score: maxScore === 100 && score > 100 ? score / 100 : score,
        maxScore,
      });
    }
    if (parsed.length > 0) return parsed;
  }

  const fallback: EvaluationDimensionScore[] = [];
  const contentScore = asNumber(source.score_content);
  const formatScore = asNumber(source.score_format);
  if (contentScore !== undefined) {
    fallback.push({
      name: "内容质量",
      score: contentScore > 100 ? contentScore / 100 : contentScore,
      maxScore: 100,
    });
  }
  if (formatScore !== undefined) {
    fallback.push({
      name: "格式规范",
      score: formatScore > 100 ? formatScore / 100 : formatScore,
      maxScore: 100,
    });
  }
  return fallback;
}

function parseBadcases(
  source: Record<string, unknown> | undefined,
): EvaluationBadcase[] {
  if (!source) return [];
  const rawList = Array.isArray(source.badcases)
    ? source.badcases
    : Array.isArray(source.cases)
      ? source.cases
      : [];
  const out: EvaluationBadcase[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const item = asRecord(rawList[i]);
    if (!item) continue;
    const status = asString(item.status) ?? asString(item.verdict) ?? "UNKNOWN";
    const isPass = /^(AC|PASS|PASSED|OK)$/i.test(status);
    if (
      Array.isArray(source.cases) &&
      !Array.isArray(source.badcases) &&
      isPass
    ) {
      continue;
    }
    const locationRaw = asRecord(item.location);
    const file = asString(locationRaw?.file) ?? asString(item.file);
    const line = asNumber(locationRaw?.line) ?? asNumber(item.line);
    const errorType = asString(item.error_type) ?? asString(item.errorType);
    const baseMessage =
      asString(item.reasoning) ??
      asString(item.message) ??
      asString(item.error) ??
      asString(item.reason);
    const message =
      errorType && baseMessage
        ? `[${errorType}] ${baseMessage}`
        : (baseMessage ?? errorType);
    const detected =
      file && line && line > 0
        ? { file, line }
        : message
          ? extractSourceLocations(message)[0]
          : undefined;
    out.push({
      caseId:
        asString(item.case_id) ??
        asString(item.caseId) ??
        asString(item.id) ??
        `#${i + 1}`,
      status,
      input: asString(item.input),
      expected:
        asString(item.expected) ?? asString(item.expected_output) ?? undefined,
      actual:
        asString(item.actual) ?? asString(item.actual_output) ?? undefined,
      message,
      location: detected,
    });
  }
  return out;
}

function parseTraces(
  source: Record<string, unknown> | undefined,
): LlmTraceEntry[] {
  if (!source) return [];
  const rawList = Array.isArray(source.traces)
    ? source.traces
    : Array.isArray(source.llm_traces)
      ? source.llm_traces
      : [];
  const out: LlmTraceEntry[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const item = asRecord(rawList[i]);
    if (!item) continue;
    const promptTokens =
      asNumber(item.prompt_tokens) ?? asNumber(item.promptTokens) ?? 0;
    const completionTokens =
      asNumber(item.completion_tokens) ?? asNumber(item.completionTokens) ?? 0;
    const totalTokens =
      asNumber(item.total_tokens) ??
      asNumber(item.totalTokens) ??
      promptTokens + completionTokens;
    const requestPreview =
      asString(item.request_preview) ??
      asString(item.requestPreview) ??
      asString(item.prompt) ??
      (Array.isArray(item.request_messages)
        ? JSON.stringify(item.request_messages)
        : "");
    const responsePreview =
      asString(item.response_preview) ??
      asString(item.responsePreview) ??
      asString(item.response) ??
      asString(item.error_code) ??
      "";
    out.push({
      index: asNumber(item.seq) ?? asNumber(item.index) ?? i + 1,
      model: asString(item.model) ?? "unknown",
      startedAtMs:
        asNumber(item.offset_ms) ??
        asNumber(item.started_at_ms) ??
        asNumber(item.startedAtMs) ??
        0,
      durationMs:
        asNumber(item.latency_ms) ??
        asNumber(item.duration_ms) ??
        asNumber(item.durationMs) ??
        0,
      promptTokens,
      completionTokens,
      totalTokens,
      status: asString(item.status) === "error" ? "error" : "ok",
      requestPreview,
      responsePreview,
    });
  }
  return out;
}

function parseMetering(
  source: Record<string, unknown> | undefined,
  traces: readonly LlmTraceEntry[],
): EvaluationFeedback["metering"] | undefined {
  const raw =
    asRecord(source?.summary) ??
    asRecord(source?.metering) ??
    asRecord(source?.usage) ??
    undefined;
  if (raw) {
    const promptTokens =
      asNumber(raw.prompt_tokens) ?? asNumber(raw.promptTokens) ?? 0;
    const completionTokens =
      asNumber(raw.completion_tokens) ?? asNumber(raw.completionTokens) ?? 0;
    const totalTokens =
      asNumber(raw.total_tokens) ??
      asNumber(raw.totalTokens) ??
      promptTokens + completionTokens;
    const costUsd =
      asNumber(raw.estimated_cost) ??
      asNumber(raw.cost_usd) ??
      asNumber(raw.costUsd) ??
      null;
    const callCount =
      asNumber(raw.total_calls) ??
      asNumber(raw.call_count) ??
      asNumber(raw.calls) ??
      (traces.length > 0 ? traces.length : 0);
    return { promptTokens, completionTokens, totalTokens, costUsd, callCount };
  }
  if (traces.length > 0) {
    const promptTokens = traces.reduce((s, t) => s + t.promptTokens, 0);
    const completionTokens = traces.reduce((s, t) => s + t.completionTokens, 0);
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd: null,
      callCount: traces.length,
    };
  }
  return undefined;
}

function collectAllLocations(
  output: string | undefined,
  badcases: readonly EvaluationBadcase[],
): SourceLocation[] {
  const seen = new Set<string>();
  const all: SourceLocation[] = [];
  for (const item of badcases) {
    if (!item.location) continue;
    const key = `${item.location.file}:${item.location.line}`;
    if (!seen.has(key)) {
      seen.add(key);
      all.push(item.location);
    }
  }
  if (output) {
    for (const loc of extractSourceLocations(output)) {
      const key = `${loc.file}:${loc.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(loc);
      }
    }
  }
  return all;
}

/** 将正式提交详情与可选 `/feedback` 载荷适配为统一可视化报告。 */
export function buildSubmissionFeedback(
  title: string,
  detail: SubmissionDetail,
  feedbackPayload?: Record<string, unknown> | null,
): EvaluationFeedback {
  if (detail.result_visibility === "hidden") {
    return {
      source: "submission",
      title,
      status: "已受理",
      score: null,
      maxScore: 100,
      hidden: true,
      summary: "结果按比赛规则暂未公开",
      dimensions: [],
      badcases: [],
      traces: [],
      locations: [],
    };
  }

  const fb = asRecord(feedbackPayload);
  if (fb?.visible === false) {
    return {
      source: "submission",
      title,
      status: "已受理",
      score: null,
      maxScore: 100,
      hidden: true,
      summary: "结果按比赛规则暂未公开",
      dimensions: [],
      badcases: [],
      traces: [],
      locations: [],
    };
  }
  const details = asRecord(detail.result?.details);
  const mergedSource = fb ?? details;

  const summaryOnly =
    detail.result_visibility === "summary" || fb?.visibility === "summary";
  const output = summaryOnly
    ? undefined
    : (asString(fb?.output) ?? detail.result?.output ?? undefined);
  const traces = summaryOnly ? [] : parseTraces(mergedSource);
  const badcases = summaryOnly ? [] : parseBadcases(mergedSource);
  const dimensions = parseDimensions(mergedSource);
  const maxScore = asNumber(fb?.max_score) ?? 100;
  const rawScore = asNumber(fb?.score) ?? detail.result?.score ?? null;
  const score =
    rawScore !== null
      ? maxScore === 100 &&
        detail.result?.score != null &&
        fb?.score === undefined
        ? Number((rawScore / 100).toFixed(2))
        : normalizeScaledScore(rawScore, maxScore)
      : null;

  return {
    source: "submission",
    title,
    status:
      asString(fb?.status) ??
      detail.result?.status ??
      detail.status ??
      "finished",
    score,
    maxScore,
    summary: asString(fb?.summary) ?? asString(details?.summary),
    output,
    outputTruncated: Boolean(detail.result?.output_truncated),
    timeMs: asNumber(fb?.time_ms) ?? detail.result?.time_ms ?? null,
    memoryKb: asNumber(fb?.memory_kb) ?? detail.result?.memory_kb ?? null,
    metering: parseMetering(mergedSource, traces),
    dimensions,
    badcases,
    traces,
    locations: summaryOnly ? [] : collectAllLocations(output, badcases),
  };
}

/** 将云端自测详情与可选 `/feedback` 载荷适配为统一可视化报告。 */
export function buildSelfTestFeedback(
  title: string,
  detail: SelfTestDetail,
  feedbackPayload?: Record<string, unknown> | null,
): EvaluationFeedback {
  const fb = asRecord(feedbackPayload);
  const details = asRecord(detail.details);
  const mergedSource = fb ?? details;

  const output = asString(fb?.output) ?? detail.output ?? undefined;
  const traces = parseTraces(mergedSource);
  const badcases = parseBadcases(mergedSource);
  const dimensions = parseDimensions(mergedSource);
  const maxScore = asNumber(fb?.max_score) ?? 100;
  const rawScore = asNumber(fb?.score) ?? detail.score;
  const score =
    fb?.score !== undefined
      ? normalizeScaledScore(rawScore, maxScore)
      : Number((detail.score / 100).toFixed(2));

  return {
    source: "self_test",
    title,
    status:
      asString(fb?.status) ??
      detail.result_status ??
      detail.status ??
      "finished",
    score,
    maxScore,
    summary: asString(fb?.summary) ?? asString(details?.summary),
    output,
    outputTruncated: Boolean(detail.output_truncated),
    timeMs: asNumber(fb?.time_ms) ?? detail.time_ms ?? null,
    memoryKb: asNumber(fb?.memory_kb) ?? detail.memory_kb ?? null,
    metering: parseMetering(mergedSource, traces),
    dimensions,
    badcases,
    traces,
    locations: collectAllLocations(output, badcases),
  };
}
